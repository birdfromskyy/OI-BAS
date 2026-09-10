<script lang="ts">
	import './layout.css';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { isPhone, PHONE_HOME, PHONE_ROUTES } from '$lib/device.svelte';
	import logo from '$lib/assets/logo.svg';
	import user from '$lib/assets/user.svg?raw';
	import Modal from '$lib/components/Modal.svelte';
	import Planned from '$lib/components/Planned.svelte';
	import Sync from '$lib/components/Sync.svelte';
	import Tag from '$lib/components/Tag.svelte';
	import type { Row } from '$lib/components/format';
	import { PROFILE_FIELDS } from '$lib/components/columns';
	import { APIError, api, accessToken, accessTokenFromURL, rememberAccessToken } from '$lib/api';
	import {
		active as accountActive,
		applyProfile,
		me,
		mayOpen,
		session,
		signedIn,
		signOut,
		updateProfile
	} from '$lib/session.svelte';
	import { personById, staff } from '$lib/staff.svelte';
	import { fleet } from '$lib/fleet.svelte';
	import { flights } from '$lib/flights.svelte';
	import { checklists } from '$lib/checklists.svelte';
	import { runs } from '$lib/runs.svelte';
	import { sites } from '$lib/sites.svelte';
	import { batteries } from '$lib/batteries.svelte';
	import { forgetAll } from '$lib/storage.svelte';
	import { flush, hasQueued, hasWaiting } from '$lib/sync.svelte';

	let { children } = $props();

	/**
	 * Разделы настольной версии. Чеклиста здесь нет: его проходят с телефона,
	 * а администратор за компьютером в него не заходит.
	 */
	const NAVS: { text: string; href: string }[] = [
		{ text: 'Панель', href: '/' },
		{ text: 'Учет', href: '/flights' },
		{ text: 'Штат', href: '/staff' },
		{ text: 'Парк БВС', href: '/BVS' },
		{ text: 'Аккумуляторы', href: '/batteries' }
	];

	/**
	 * Меню собирается по правам (раздел 2.2): раздел, который пользователю
	 * нечего открывать, не показывается. Это удобство, а не защита — тем же
	 * правилом закрыт и прямой заход по ссылке, см. `allowed` ниже.
	 */
	const navs = $derived(NAVS.filter((n) => mayOpen(n.href)));

	/** Открыт ли текущий раздел этому пользователю */
	const allowed = $derived(mayOpen(page.url.pathname));

	/**
	 * Три состояния до разделов, и порядок их важен.
	 *
	 * Приём приглашения открыт всем: на него приходят как раз без доступа.
	 * Дальше — токен устройства: нет действующего, значит пользователь не вошёл
	 * либо вышел, либо его токены погашены. И только потом состояние учётной
	 * записи: деактивированный сохраняет токен, но приложение ему не отвечает
	 * (ФТ-1.9), а пришедший по многоразовой ссылке ждёт подтверждения (ФТ-1.4).
	 */
	const entry = $derived(page.url.pathname === '/join');
	const signed = $derived(signedIn());
	const working = $derived(accountActive());
	/** Состояние карточки: им объясняется, почему доступ закрыт */
	const standing = $derived(personById(me.id)?.status ?? me.status);

	/** Вставленная ссылка приглашения — единственный способ войти (ФТ-1.6) */
	let link = $state('');

	function enter() {
		const token = accessTokenFromURL(link.trim());
		if (!token) return;
		rememberAccessToken(token);
		location.assign('/');
	}

	function replace<T>(target: T[], values: T[] = []) {
		target.splice(0, target.length, ...values);
	}
	/**
	 * Bootstrap — это снимок на момент запроса, а не команда выбросить
	 * офлайн-изменения. Записи с очередью (включая конфликтные) оставляем
	 * локальными, а серверные значения берём лишь там, где локальной правки нет.
	 */
	function reconcile<T extends { id: string }>(target: T[], remote: T[] = [], entity: string) {
		const local = new Map(target.map((item) => [item.id, item]));
		const remoteIDs = new Set(remote.map((item) => item.id));
		const merged = remote.map((item) =>
			hasQueued(entity, item.id) ? (local.get(item.id) ?? item) : item
		);
		for (const item of target) {
			if (!remoteIDs.has(item.id) && hasQueued(entity, item.id)) merged.push(item);
		}
		replace(target, merged);
	}
	function applySyncRevision(event: Event) {
		const detail = (
			event as CustomEvent<{
				operationId: string;
				entity: string;
				recordId: string;
				revision: number;
				action: 'upsert' | 'delete';
				data: unknown;
			}>
		).detail;
		const collections: Record<string, { id: string; revision?: number }[]> = {
			aircraft: fleet,
			checklist: checklists,
			flight: flights,
			run: runs,
			site: sites,
			battery: batteries
		};
		const collection = collections[detail.entity];
		if (!collection) return;
		const index = collection.findIndex((item) => item.id === detail.recordId);
		// Во время HTTP-ответа пользователь мог успеть сохранить эту же запись
		// снова. Не подменяем свежий локальный черновик ответом на старую версию;
		// ему нужна только новая ревизия, с которой очередь отправит следующий шаг.
		if (hasWaiting(detail.entity, detail.recordId, detail.operationId)) {
			if (index >= 0) collection[index].revision = detail.revision;
			return;
		}
		if (detail.action === 'delete') {
			if (index >= 0) collection.splice(index, 1);
			return;
		}
		// detail.data is a JSON payload. It may cross this boundary as a Svelte
		// reactive proxy, which structuredClone cannot clone; JSON is the stable
		// format used by the API and offline storage as well.
		const data = JSON.parse(JSON.stringify(detail.data)) as { id: string; revision?: number };
		if (!data?.id) return;
		data.revision = detail.revision;
		if (index >= 0) collection[index] = data;
		else collection.push(data);
	}
	async function loadServerState() {
		if (!accessToken()) {
			session.ready = true;
			return;
		}
		try {
			const data = await (await api('/bootstrap')).json();
			// Не запускаем flush между получением снимка и его склейкой с localStorage.
			applyProfile(data.profile, false);
			replace(staff, data.users);
			reconcile(fleet, data.aircraft, 'aircraft');
			reconcile(checklists, data.checklists, 'checklist');
			reconcile(flights, data.flights, 'flight');
			reconcile(runs, data.runs, 'run');
			reconcile(sites, data.sites, 'site');
			reconcile(batteries, data.batteries, 'battery');
			session.error = '';
			void flush();
		} catch (error) {
			session.error = error instanceof Error ? error.message : 'Не удалось подключиться к серверу';
			// Без сети PWA продолжает работать с профилем и данными того же
			// сотрудника из localStorage. Ссылку забываем только когда сервер
			// прямо подтвердил её отзыв или деактивацию.
			if (error instanceof APIError && error.status === 401) signOut();
		} finally {
			session.ready = true;
		}
	}
	if (typeof window !== 'undefined') {
		window.addEventListener('ekipazh:sync-ack', applySyncRevision);
		// Конфликт не затирает локальную посылку, но экран возвращается к
		// серверной версии. Осознанная новая правка заменит заблокированную
		// посылку в очереди и уйдёт уже с актуальной ревизией.
		window.addEventListener('ekipazh:sync-conflict', () => void loadServerState());
		void loadServerState();
	}

	const phone = $derived(isPhone.current);

	/**
	 * С телефона доступны только планируемые полёты и чеклист: пилот на площадке
	 * не отвлекается на журналы и справочники. С компьютера доступно всё,
	 * включая эти два экрана, — администратору нужно видеть, по чему проверяют.
	 * Проверка на клиенте: ширину окна сервер не знает.
	 */
	/** Доступен ли текущий адрес с телефона. Считается из адреса, а не из устройства */
	const forPhone = $derived(PHONE_ROUTES.includes(page.url.pathname));

	/** На панели карта идёт до краёв; остальные страницы получают поля макета. */
	const FULL_WIDTH = ['/'];
	const bleed = $derived(FULL_WIDTH.includes(page.url.pathname));

	$effect(() => {
		// обе величины читаются безусловно: при `phone && …` вычисление обрывается
		// на false, адрес не попадает в зависимости и смена страницы проходит мимо
		const mobile = phone;
		const ok = forPhone;
		if (mobile && !ok) goto(PHONE_HOME, { replaceState: true });
	});

	/** На чеклисте нужна дорога назад к списку полётов — меню на телефоне нет */
	const back = $derived(phone && page.url.pathname === '/list');
	let show: boolean = $state(false);

	/**
	 * Подсветка берётся из адреса, а не из клика по ссылке: иначе при прямой
	 * загрузке страницы и при кнопке «назад» подсвечен не тот пункт.
	 */
	function active(href: string): boolean {
		const path = page.url.pathname;
		if (href === '/') return path === '/';
		// чеклист открывается из планируемых полётов и остаётся тем же разделом
		if (href === PHONE_HOME) return path === PHONE_HOME || path === '/list';
		return path.startsWith(href);
	}

	async function save(row: Row) {
		// правится запись целиком: она общая для всего приложения, переприсвоить
		// экспортированную переменную нельзя, поэтому поля переносятся в неё
		await updateProfile({ name: String(row.name ?? ''), phone: String(row.phone ?? '') });
		// в штате тот же человек: ФИО из профиля должно совпадать с карточкой,
		// иначе в журнале полётов он окажется под двумя именами
		const card = personById(me.id);
		if (card) {
			card.name = me.name;
			card.phone = me.phone;
		}
		show = false;
	}

	/** Выход гасит токен этого устройства: вернуться можно только по новой ссылке */
	function leave() {
		show = false;
		signOut();
		goto('/', { replaceState: true });
	}
</script>

<svelte:head><link rel="icon" href={logo} /></svelte:head>

<!-- шапка липкая: на телефоне она заменяет панель приложения -->
<header class="sticky top-0 z-30 flex items-center justify-between gap-3 border-b bg-front p-4">
	<nav class="flex items-center gap-2">
		<img src={logo} alt="" />

		{#if !signed || entry}
			<span class="text-lg">Экипаж</span>
		{:else if phone}
			{#if back}
				<a href={PHONE_HOME} class="click rounded-sm p-1.5 text-accent" aria-label="К полётам">
					‹ Полёты
				</a>
			{:else}
				<span class="text-lg">Планируемые полёты</span>
			{/if}
		{:else}
			{#each navs as { text, href } (href)}
				<a
					{href}
					class={['click rounded-sm p-1.5', active(href) && 'bg-accent/15 text-accent']}
					aria-current={active(href) ? 'page' : undefined}
				>
					{text}
				</a>
			{/each}
		{/if}
	</nav>

	{#if signed && !entry}
		<div class="flex items-center gap-3">
			<Sync />

			<Tag level="info" size="md" onclick={() => (show = true)}>
				<span class="flex max-w-48 items-center gap-2 [&_svg]:w-4 [&_svg]:shrink-0">
					{@html user}
					<span class="truncate">{me.name}</span>
				</span>
			</Tag>
		</div>
	{/if}
</header>

<!-- на телефоне поля минимальны: экран занимает содержимое, как в приложении -->
<main class={['flex', !bleed && 'px-4 py-4 md:px-20 md:py-15']}>
	{#if entry}
		<!-- приглашение принимают без доступа: это единственная дверь снаружи -->
		{@render children()}
	{:else if !session.ready && accessToken()}
		<!-- Ссылка уже записана синхронно, но профиль ещё приходит с API. В этот
		     короткий момент не показываем форму повторного входа. -->
		<section class="mx-auto flex w-full max-w-2xl flex-col items-center gap-3 py-12">
			<h2 class="text-2xl">Проверяем ссылку…</h2>
			<p class="text-center text-text-muted">Загружаем профиль и данные компании.</p>
		</section>
	{:else if !signed && standing !== 'деактивирован'}
		<!-- деактивированному форма входа не нужна: ссылка ему больше не поможет,
		     и устройство помнит, чья это учётная запись -->
		<section class="mx-auto flex w-full max-w-2xl flex-col gap-4 py-10">
			<header class="flex flex-col items-center gap-2 rounded-lg border bg-front p-6">
				<h2 class="text-2xl">Вход по ссылке</h2>
				<p class="text-center text-text-muted">
					Пароля в системе нет. Администратор компании присылает персональную ссылку — откройте её
					на этом устройстве, и оно запомнит вход.
				</p>
			</header>

			<label class="flex flex-col gap-2">
				<span class="text-text-muted">Персональная ссылка</span>
				<input
					bind:value={link}
					class="min-h-touch rounded-lg border px-3"
					placeholder="https://…/#access=…"
					onkeydown={(e) => e.key === 'Enter' && enter()}
				/>
			</label>

			<button
				class="click min-h-touch rounded-lg border border-accent bg-accent/15 p-3 text-accent disabled:opacity-40"
				disabled={!accessTokenFromURL(link)}
				onclick={enter}
			>
				Войти
			</button>

			{#if session.error}
				<p class="text-center text-sm text-heat-bad">{session.error}</p>
			{/if}

			<button class="click min-h-0 rounded-sm p-2 text-sm text-text-muted" onclick={forgetAll}>
				Стереть данные на этом устройстве
			</button>
		</section>
	{:else if !working || !signed}
		<section class="mx-auto flex w-full max-w-2xl flex-col items-center gap-3 py-12">
			<h2 class="text-2xl">Доступ приостановлен</h2>
			<p class="text-center text-text-muted">
				{me.name}: учётная запись деактивирована администратором компании. Данные сохранены, доступ
				закрыт.
			</p>

			<!-- на устройстве лежат только местные данные, поэтому демонстрацию
			     можно начать заново, не залезая в отладчик браузера -->
			<button
				class="click min-h-0 rounded-sm border px-3 py-1.5 text-text-muted"
				onclick={forgetAll}
			>
				Стереть данные на этом устройстве
			</button>
		</section>
	{:else if !allowed}
		<!-- раздел закрыт ролью: сообщение вместо экрана, а не пустая страница,
		     иначе прямая ссылка выглядит поломкой (раздел 2.2) -->
		<section class="mx-auto flex w-full max-w-2xl flex-col items-center gap-3 py-12">
			<h2 class="text-2xl">Раздел закрыт</h2>
			<p class="text-center text-text-muted">
				Роли «{me.roles.join('», «')}» не дают доступа к этому разделу. Права назначает
				администратор компании.
			</p>
			<a href="/" class="click min-h-0 rounded-sm border px-3 py-1.5 text-text-muted">На главную</a>
		</section>
	{:else if forPhone}
		{@render children()}
	{:else}
		<!-- Настольный раздел на узком экране не показывается вовсе: подмена идёт
		     брейкпоинтом CSS, а не только переходом в скрипте, поэтому не зависит
		     ни от разрешений, ни от того, успел ли отработать роутер -->
		<div class="hidden w-full md:flex">
			{@render children()}
		</div>

		<section class="mx-auto flex w-full max-w-2xl flex-col gap-3 md:hidden">
			<Planned />
		</section>
	{/if}
</main>

<!-- профиль живёт в макете: он доступен с любой страницы, а не только со списка штата -->
<Modal
	bind:show
	row={me}
	fields={PROFILE_FIELDS}
	table
	title="Профиль"
	onsave={save}
	onclose={() => (show = false)}
>
	<div class="flex flex-col gap-2 border-t pt-4">
		<div class="flex items-center justify-between gap-3">
			<p class="text-sm text-text-muted">Устройство помнит вход бессрочно</p>
			<button
				type="button"
				class="click min-h-0 cursor-pointer rounded-sm border px-3 py-1.5 text-sm text-text-muted"
				onclick={leave}
			>
				Выйти с устройства
			</button>
		</div>
	</div>
</Modal>
