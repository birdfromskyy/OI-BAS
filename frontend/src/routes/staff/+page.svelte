<script lang="ts">
	import Table from '$lib/components/Table.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import type { Column, Row, TableAction } from '$lib/components/format';
	import user from '$lib/assets/user.svg?raw';
	import { STAFF_COLUMNS, STAFF_FIELDS } from '$lib/components/columns';
	import type { Person } from '$lib/mocs/staff';
	import { assignableBy, OWNER, ROLES } from '$lib/roles';
	import { isMe, may, me } from '$lib/session.svelte';
	import { api } from '$lib/api';
	import { staff } from '$lib/staff.svelte';

	let opened = $state<Person | null>(null);
	let creating = $state(false);
	/** Последняя добавленная или изменённая запись — таблица покажет её страницу */
	let touched = $state<string>();
	/** Передача владения в два шага: первый клик спрашивает, второй выполняет */
	let handing = $state(false);
	/** Отзыв ссылки также требует второго нажатия, без браузерного alert. */
	let confirmingRevoke = $state(false);
	/** Feedback stays inside the application; browser alert dialogs interrupt PWA work. */
	let feedback = $state('');

	/**
	 * Пользователей и роли заводит администратор и владелец (раздел 2.2);
	 * остальным штат виден только на чтение — карточка открывается без правки.
	 */
	const toolbar: TableAction[] = $derived(
		may('C', 'пользователи')
			? [
					{
						key: 'add',
						label: 'Добавить сотрудника',
						icon: user,
						tone: 'accent',
						onclick: () => {
							opened = blank();
							creating = true;
						}
					}
				]
			: []
	);

	/**
	 * Роли, которыми распоряжается текущий пользователь (ФТ-1.2): владелец
	 * раздаёт любые, администратор — всё, кроме администратора и владельца.
	 * Остальные роли остаются в карточке видимыми, но не снимаются: иначе
	 * «не могу назначить, зато могу снять» обходило бы правило целиком.
	 */
	const assignable = $derived(assignableBy(me.roles));
	const locked = $derived(ROLES.filter((r) => !assignable.includes(r)));

	/**
	 * Состояние учётной записи меняется не у всех: себя не деактивирует никто —
	 * иначе администратор запирает сам себя, — а владельца не деактивирует даже
	 * он сам, пока не передаст владение. Деактивированный теряет доступ (ФТ-1.9),
	 * и компания без владельца осталась бы без того, кто назначает администраторов.
	 */
	const mayManageOpenedAdmin = $derived(
		isMe(OWNER) || !opened?.roles.includes('администратор') || opened?.id === me.id
	);
	const mayStatus = $derived(
		creating ||
			(!!opened && opened.id !== me.id && !opened.roles.includes(OWNER) && mayManageOpenedAdmin)
	);

	/**
	 * Обычный администратор не управляет доступом другого администратора:
	 * это равнозначно лишению коллеги доступа. Собственную ссылку он может
	 * перевыпустить; владельцу доступны ссылки всех сотрудников.
	 */
	const mayManageLink = $derived(
		!!opened &&
			!creating &&
			opened.status !== 'деактивирован' &&
			may('C', 'пользователи') &&
			mayManageOpenedAdmin
	);

	/**
	 * Налёт и число полётов считаются из журнала и у нового сотрудника
	 * заведомо нулевые: в карточке заведения им делать нечего — там спрашивают,
	 * а не показывают. У работающего они остаются: это его итог за всё время.
	 */
	const shown = $derived(
		creating ? STAFF_FIELDS.filter((f) => f.key !== 'hours' && f.key !== 'flights') : STAFF_FIELDS
	);

	const fields: Column[] = $derived(
		shown.map((f) =>
			f.key === 'roles'
				? { ...f, options: assignable, locked }
				: f.key === 'status'
					? {
							...f,
							edit: mayStatus ? f.edit : undefined
						}
					: f
		)
	);

	/** Владение передаёт только владелец и только действующему сотруднику */
	const heir = $derived(
		opened && !creating && isMe(OWNER) && opened.id !== me.id && opened.status === 'активен'
			? opened
			: undefined
	);

	/** Заготовка пользователя: «приглашён», пока не примет приглашение (ФТ-1.4) */
	function blank(): Person {
		return {
			id: '',
			name: '',
			roles: [],
			phone: '',
			hours: 0,
			flights: 0,
			// Сотрудник становится активным при первом переходе по персональной
			// ссылке. До этого статус позволяет открыть и перевыпустить ссылку
			// прямо из его карточки.
			status: 'приглашён'
		};
	}

	async function save(row: Row) {
		feedback = '';
		const updated = row as Person;
		const before = staff.find((p) => p.id === updated.id)?.roles ?? [];
		// роли, которыми правящий не распоряжается, остаются как были: карточка
		// их не даёт тронуть, но полагаться только на разметку нельзя
		updated.roles = [
			...before.filter((r) => !assignable.includes(r)),
			...updated.roles.filter((r) => assignable.includes(r))
		];

		const isNew = creating;
		try {
			if (isNew) {
				const result = await (
					await api('/users', { method: 'POST', body: JSON.stringify(updated) })
				).json();
				staff.push(result.user);
				touched = result.user.id;
				invited = result.user;
				invitedLink = result.accessUrl;
			} else {
				await api(`/users/${updated.id}`, { method: 'PUT', body: JSON.stringify(updated) });
				const i = staff.findIndex((p) => p.id === updated.id);
				// `updated` is a Svelte reactive proxy. Browser structuredClone cannot
				// clone that proxy (and may include modal metadata), so store the
				// explicit API record instead of cloning the UI object.
				if (i >= 0) {
					staff[i] = {
						id: updated.id,
						name: updated.name,
						roles: [...updated.roles],
						phone: updated.phone,
						hours: updated.hours,
						flights: updated.flights,
						status: updated.status
					};
				}
				touched = updated.id;
				if (updated.id === me.id) me.roles = [...updated.roles];
			}
			close();
		} catch (error) {
			feedback = error instanceof Error ? error.message : 'Не удалось сохранить сотрудника';
		}
	}

	async function remove(row: Row) {
		feedback = '';
		// исторические записи деактивированного сохраняются (ФТ-1.9), поэтому
		// удаление — крайняя мера; доступ закрывается вместе с ним в любом случае
		try {
			await api(`/users/${row.id}`, {
				method: 'PUT',
				body: JSON.stringify({ ...row, status: 'деактивирован' })
			});
			const person = staff.find((p) => p.id === row.id);
			if (person) person.status = 'деактивирован';
			close();
		} catch (error) {
			feedback = error instanceof Error ? error.message : 'Не удалось деактивировать сотрудника';
		}
	}

	/** Передача владения: у прежнего владельца роль снимается тем же действием */
	function hand(person: Person) {
		if (!handing) {
			handing = true;
			return;
		}
		void transfer(person);
	}

	function close() {
		opened = null;
		creating = false;
		handing = false;
		confirmingRevoke = false;
	}

	/* ── Приглашения по ссылке (ФТ-1.2, ФТ-1.3, ФТ-1.5) ── */

	/** Сотрудник, чью ссылку показываем отдельным окном */
	let invited = $state<Person | null>(null);
	/** Окно открыто сразу после добавления, а не по тегу «приглашён» */
	let invitedLink = $state('');
	/** Какая ссылка только что скопирована — подпись возвращается на кнопку */
	let copied = $state('');

	async function issueFor(person: Person) {
		feedback = '';
		try {
			const result = await (
				await api(`/users/${person.id}/access-link`, { method: 'POST' })
			).json();
			invitedLink = result.accessUrl;
			copied = '';
			invited = person;
			return true;
		} catch (error) {
			feedback = error instanceof Error ? error.message : 'Не удалось выдать ссылку';
			return false;
		}
	}

	/** Сырой токен не хранится, поэтому показ ссылки всегда означает её перевыпуск. */
	async function showLink(person: Person) {
		if (await issueFor(person)) close();
	}

	async function copy() {
		try {
			await navigator.clipboard.writeText(invitedLink);
			copied = invitedLink;
		} catch {
			// буфер закрыт настройками браузера — ссылка показана текстом рядом
			copied = '';
		}
	}

	async function revokeLink(person: Person) {
		feedback = '';
		try {
			await api(`/users/${person.id}/access-link`, { method: 'DELETE' });
			if (invited?.id === person.id) invitedLink = '';
			feedback = 'Ссылка отозвана.';
		} catch (error) {
			feedback = error instanceof Error ? error.message : 'Не удалось отозвать ссылку';
		}
	}

	function requestRevoke(person: Person) {
		if (!confirmingRevoke) {
			confirmingRevoke = true;
			return;
		}
		confirmingRevoke = false;
		void revokeLink(person);
	}
	async function transfer(person: Person) {
		feedback = '';
		try {
			await api(`/users/${person.id}/transfer-ownership`, { method: 'POST' });
			for (const p of staff) p.roles = p.roles.filter((role) => role !== OWNER);
			person.roles = [OWNER, ...person.roles];
			me.roles = me.roles.filter((role) => role !== OWNER);
			close();
		} catch (error) {
			feedback = error instanceof Error ? error.message : 'Не удалось передать владение';
		}
	}

	const SMALL = 'click min-h-0 cursor-pointer rounded-sm border px-3 py-1.5 text-sm';
</script>

<!-- ссылка выглядит одинаково всюду, где её показывают: в окне после добавления
     и в карточке приглашённого, пока он не вошёл -->
{#snippet link(person: Person)}
	<div class="flex flex-col gap-2 border-t pt-4">
		{#if invitedLink}
			<p class="text-sm text-text-muted">
				Ссылка для входа: {person.name || 'сотрудник'} · роли {person.roles.join(', ') ||
					'не назначены'}. Ссылка бессрочная, пока её не отзовёт администратор. Пароль не
				понадобится — перешедший по ссылке сразу окажется в системе.
			</p>
			<code class="rounded-sm border p-2 text-sm break-all text-accent">{invitedLink}</code>
			<div class="flex flex-wrap gap-2">
				<button type="button" class="{SMALL} border-accent bg-accent/15 text-accent" onclick={copy}>
					{copied === invitedLink ? 'Скопировано' : 'Скопировать ссылку'}
				</button>
				<button type="button" class="{SMALL} text-text-muted" onclick={() => issueFor(person)}>
					Выдать новую
				</button>
				<button
					type="button"
					class="{SMALL} border-heat-bad text-heat-bad"
					onclick={() => requestRevoke(person)}
				>
					{confirmingRevoke ? 'Подтвердить отзыв' : 'Отозвать'}
				</button>
			</div>
		{:else}
			<p class="text-sm text-text-muted">
				Действующей ссылки нет — прежняя отозвана или истекла, а сотрудник ещё не вошёл.
			</p>
			<button
				type="button"
				class="{SMALL} self-start border-accent bg-accent/15 text-accent"
				onclick={() => issueFor(person)}
			>
				Выдать ссылку
			</button>
		{/if}
	</div>
{/snippet}

<section class="w-full">
	{#if feedback}
		<p
			class="mb-3 rounded-sm border border-heat-bad bg-heat-bad/15 px-3 py-2 text-sm text-heat-bad"
			role="status"
		>
			{feedback}
		</p>
	{/if}
	<Table
		data={staff}
		columns={STAFF_COLUMNS}
		{toolbar}
		title="Штат"
		focus={touched}
		defaultSort="flights"
		onselect={(row) => (opened = row as Person)}
	/>

	<Modal
		show={opened !== null}
		row={opened ?? undefined}
		{fields}
		{creating}
		table
		title={creating ? 'Новый сотрудник' : (opened?.name ?? '')}
		onsave={may('U', 'пользователи') ? save : undefined}
		ondelete={may('D', 'пользователи') && !opened?.roles.includes(OWNER) && mayManageOpenedAdmin
			? remove
			: undefined}
		onclose={close}
	>
		{#if opened && !creating && !mayStatus}
			<p class="border-t pt-4 text-sm text-text-muted">
				{opened.id === me.id
					? 'Свою учётную запись деактивировать нельзя.'
					: 'Владельца компании нельзя деактивировать: сначала владение передаётся другому.'}
			</p>
		{/if}

		{#if opened && mayManageLink}
			<!-- Ссылка — отдельное действие, а не кликабельный статус сотрудника. -->
			<div class="flex flex-wrap items-center gap-2 border-t pt-4">
				<button
					type="button"
					class="{SMALL} border-accent bg-accent/15 text-accent"
					onclick={() => showLink(opened as Person)}
				>
					Обновить ссылку для входа
				</button>
				<button
					type="button"
					class="{SMALL} border-heat-bad text-heat-bad"
					onclick={() => requestRevoke(opened as Person)}
				>
					{confirmingRevoke ? 'Подтвердить отзыв ссылки' : 'Отозвать ссылку'}
				</button>
			</div>
		{/if}

		{#if heir}
			<!-- владелец в компании один: роль не выдаётся, а переходит целиком -->
			<div class="flex flex-col gap-2 border-t pt-4">
				<button
					type="button"
					class="{SMALL} border-heat-bad bg-heat-bad/15 text-heat-bad"
					onclick={() => hand(heir)}
				>
					{handing ? `Точно передать владение: ${heir.name}?` : 'Передать владение'}
				</button>
			</div>
		{/if}
	</Modal>

	<!-- второй шаг добавления: сотрудник заведён, осталось передать ему ссылку -->
	<Modal show={invited !== null} title="Сотрудник добавлен" onclose={() => (invited = null)}>
		{#if invited}
			<p class="text-sm text-text-muted">
				Карточка создана, вход откроется по ссылке. До первого входа сотрудник числится приглашённым
				— ссылка останется в его карточке, скопировать её можно в любой момент.
			</p>
			{@render link(invited)}
		{/if}
	</Modal>
</section>
