<script lang="ts">
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import Modal from '$lib/components/Modal.svelte';
	import Tag from '$lib/components/Tag.svelte';
	import type { StatusLevel } from '$lib/components/format';
	import type { ChecklistItem } from '$lib/mocs/checklists';
	import { checklistFor } from '$lib/checklists.svelte';
	import { answerItem, openRunFor, runFor, signRun, startRun, voidRun } from '$lib/runs.svelte';
	import { locate, weatherAt, type Spot } from '$lib/meteo';
	import {
		finishFlight,
		flightById,
		markPrepared,
		startedAt,
		startFlight
	} from '$lib/flights.svelte';
	import { duration, showDate } from '$lib/components/format';
	import { may, me, mine, signature } from '$lib/session.svelte';

	/**
	 * Прохождение предполётного чеклиста (ФТ-6).
	 * Пункты предъявляются по одному: экран рассчитан на работу одной рукой
	 * в перчатках (НФТ-5.1), поэтому кнопки крупные и их немного.
	 *
	 * Элемент управления зависит от типа пункта (ФТ-4.6): да/нет — две кнопки,
	 * число — ввод с проверкой диапазона, выбор — список вариантов,
	 * фото и подпись — свои действия.
	 */
	/**
	 * Чеклист берётся от борта выбранного полёта (ФТ-5.2): экран открывается
	 * из списка планируемых полётов ссылкой /list?flight=<id>.
	 */
	const flight = $derived(flightById(page.url.searchParams.get('flight')));
	const checklist = $derived(
		flight ? checklistFor(flight.aircraftId, flight.aircraft, flight.checklist) : undefined
	);

	/** Ответ пилота хранится прямо на пункте: value — результат, note — примечание */
	type Answered = ChecklistItem & { value: boolean | number | string | null; note: string };

	/** Незакрытое прохождение этого полёта — к нему возвращаются, а не начинают заново */
	const run = $derived(flight ? openRunFor(flight.id) : undefined);

	/**
	 * Пункты с уже записанными ответами: прогресс живёт в прохождении,
	 * экран его только показывает (ФТ-6.7).
	 */
	function fresh(): Answered[] {
		const saved = run?.answers ?? [];
		return (checklist?.items ?? []).map((i) => {
			const a = saved.find((x) => x.itemId === i.id);
			return { ...i, value: a?.value ?? null, note: a?.note ?? '' };
		});
	}

	// начальное значение задаётся сразу, а не эффектом: на сервере эффекты
	// не выполняются, и первая отрисовка осталась бы без пунктов
	let items = $state<Answered[]>(fresh());
	let index = $state(0);

	/** Первый неотвеченный пункт: сюда возвращается прерванная проверка (ФТ-6.7) */
	function resumeAt(list: Answered[]): number {
		const i = list.findIndex((x) => x.value === null);
		return i < 0 ? list.length : i;
	}

	const item = $derived(items[index]);
	const done = $derived(items.length > 0 && index >= items.length);

	/** Черновик числового ответа: пустая строка, пока пилот ничего не ввёл */
	let numberDraft = $state('');
	/** Показывать ли подсказку о выходе за диапазон (ФТ-6.5) */
	const outOfRange = $derived.by(() => {
		if (!item || item.kind !== 'число' || numberDraft === '') return false;
		const v = Number(numberDraft);
		return v < (item.min ?? -Infinity) || v > (item.max ?? Infinity);
	});

	/**
	 * Этап работы с полётом (ФТ-5.7). Определяется статусом самой записи,
	 * а не местным флагом: вернувшись на экран, пилот попадает туда,
	 * где остановился, — на чеклист, на взлёт или на таймер.
	 */
	const stage = $derived(
		flight?.status === 'выполняется'
			? 'полёт'
			: flight?.status === 'завершён' || flight?.status === 'отменён'
				? 'итог'
				: flight?.status === 'подготовка пройдена'
					? 'взлёт'
					: 'чеклист'
	);

	/** Пункты показываются после подтверждения чеклиста — это шаг «выбор чеклиста» */
	let opened = $state(false);

	/**
	 * Идёт незакрытая проверка: экран занимают её пункты и завершение.
	 * Подписанное прохождение из `openRunFor` не возвращается, поэтому подпись
	 * сама переводит пилота к вылету — отдельного признака для этого не нужно.
	 */
	const checking = $derived(opened && !!run);

	/**
	 * Проверку проводит пилот (раздел 2.2), а взлёт и посадку отмечает тот,
	 * за кем записан полёт: это фиксация факта, а не правка карточки, поэтому
	 * право на неё остаётся и после того, как запись полёта закрылась.
	 */
	const mayCheck = $derived(may('C', 'прохождение'));
	const mayFly = $derived(may('C', 'фиксация', mine(flight)));

	/**
	 * Обязательные параметры прохождения: дата, время начала и конца, локация,
	 * погода и пилот. Всё, кроме погоды, заполняется само — из плана полёта,
	 * профиля и часов устройства. Погоду пилот вводит руками до тех пор,
	 * пока её не начнёт подтягивать метеослужба по координатам площадки.
	 */
	let weather = $state('');
	let startedCheck = $state('');
	let finishedCheck = $state('');

	/** Координаты площадки с устройства и состояние их получения */
	let spot = $state<Spot | null>(null);
	let sensing = $state(false);
	let sensorError = $state('');

	/**
	 * Что именно проходим сейчас. Пока это тот же полёт и то же прохождение,
	 * экран не трогают: правка чеклиста в парке БВС идёт по своей версии
	 * и начатую проверку не отменяет (ФТ-4.10). Новый чеклист выбирается
	 * только до начала — тогда в ключе стоит его версия.
	 */
	const key = $derived(
		run ? `${flight?.id}·${run.id}` : `${flight?.id}·${checklist?.id}·${checklist?.version}`
	);

	/**
	 * Открыть прохождение: пункты с записанными ответами и первый неотвеченный
	 * пункт. Эффект зависит только от ключа — иначе каждый ответ, попадая
	 * в прохождение, перезапускал бы проверку с первого пункта (ФТ-6.7).
	 */
	$effect(() => {
		key;
		untrack(() => {
			items = fresh();
			index = resumeAt(items);

			// проверку начали и не подписали — возвращаемся в неё, а не на выбор
			// чеклиста: время начала, погода и координаты уже записаны
			if (!run) {
				opened = false;
				return;
			}
			startedCheck = run.startedAt;
			finishedCheck = run.finishedAt;
			weather = run.weather;
			if (run.lat || run.lon) spot = { lat: run.lat, lon: run.lon };
			opened = true;
		});
	});

	/**
	 * Снять координаты и погоду по ним. Оба параметра обязательные, но
	 * автоматика ненадёжна: без разрешения, без сети и на http геолокация
	 * откажет — тогда пилот вводит погоду руками, а координаты берутся
	 * плановые из полёта.
	 */
	async function sense() {
		sensing = true;
		sensorError = '';
		try {
			spot = await locate();
			weather = await weatherAt(spot);
		} catch (e) {
			sensorError = e instanceof Error ? e.message : 'Не удалось определить';
		} finally {
			sensing = false;
		}
	}

	// пробуем один раз при открытии карточки полёта, до начала проверки
	let sensed = false;
	$effect(() => {
		if (stage === 'чеклист' && !opened && !sensed) {
			sensed = true;
			sense();
		}
	});

	/** Шапка прохождения — то, что попадёт в подпись */
	const heading = $derived([
		{ label: 'Дата', value: showDate(flight?.date ?? '') },
		{ label: 'Начало проверки', value: startedCheck || '—' },
		{ label: 'Конец проверки', value: finishedCheck || '—' },
		{
			label: 'Локация',
			value: spot
				? `${flight?.site || 'без названия'} · ${spot.lat}, ${spot.lon}`
				: flight?.site || 'не задана'
		},
		{ label: 'Погода', value: weather || 'не указана' },
		{ label: 'Пилот', value: flight?.pilot ?? me.name }
	]);

	function begin() {
		if (!flight || !checklist) return;
		const created = startRun(flight, checklist, weather.trim(), spot);
		flight.runId = created.id;
		startedCheck = created.startedAt;
		finishedCheck = '';
		items = fresh();
		index = 0;
		opened = true;
	}

	/** Часы таймера: обновляем раз в секунду, пока борт в воздухе */
	let now = $state(Date.now());
	$effect(() => {
		if (stage !== 'полёт') return;
		const id = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(id);
	});

	const elapsed = $derived.by(() => {
		if (!flight) return '00:00:00';
		const sec = Math.max(0, Math.floor((now - startedAt(flight.id)) / 1000));
		const h = Math.floor(sec / 3600);
		const m = Math.floor((sec % 3600) / 60);
		return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
	});

	let noteOpen = $state(false);
	let noteDraft = $state('');

	/**
	 * Описание прохождения — свободный текст обо всей проверке, а не о пункте.
	 * Пишется на экране подписи и уходит в примечания полёта, поэтому остаётся
	 * в записи после взлёта, в отличие от ответов по пунктам.
	 */
	let describe = $state('');

	/** Ответ пилота словами: для списка перед подписью */
	function shown(i: Answered): string {
		if (i.value === null) return 'пропущено';
		if (i.value === true) return 'соответствует';
		if (i.value === false) return 'не соответствует';
		if (i.kind === 'число') return `${i.value}${i.unit ? ' ' + i.unit : ''}`;
		return String(i.value);
	}

	/**
	 * Подпись закрывает проверку целиком (ФТ-6.8). Пунктом чеклиста она больше
	 * не является: подписывают проведённую проверку, а не строку в списке,
	 * и в протоколе подпись стоит рядом с датой и координатами, а не среди
	 * ответов. Полёт после этого считается подготовленным (ФТ-5.7).
	 */
	function sign() {
		if (!run) return;
		signRun(run, signature(), describe.trim());
		finishedCheck = run.finishedAt;
		describe = '';
		if (flight) markPrepared(flight.id);
	}

	/** Крупная кнопка под перчатку (НФТ-5.2) */
	const BTN = 'click min-h-touch-lg rounded-lg border p-3 text-lg';

	/**
	 * Куда вернуться после правки одного пункта (ФТ-6.10).
	 *
	 * Со сводки перед подписью пилот видит, что подтверждает, и там же
	 * замечает ошибку: не тот ответ, забытое примечание. Идти к пункту заново
	 * через весь чеклист незачем — он открывается по нажатию, а после ответа
	 * экран возвращается ровно туда, откуда пилот ушёл. null — идём по порядку.
	 */
	let back = $state<number | null>(null);
	const fixing = $derived(back !== null);

	/** Открыть пункт на правку, запомнив место возврата */
	function revisit(at: number) {
		back = index;
		index = at;
		// в поле ввода возвращается записанный ответ: пилот правит значение,
		// а не набирает его заново, и видит, что там было
		const value = items[at]?.value;
		numberDraft =
			value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
	}

	/** Вернуться туда, откуда пришли на правку */
	function backToSummary() {
		if (back === null) return;
		index = back;
		back = null;
		numberDraft = '';
	}

	function answer(value: boolean | number | string) {
		items[index].value = value;
		// ответ уходит в прохождение сразу, а не в конце: прервались — ничего не потеряно
		if (run) answerItem(run, items[index].id, value, items[index].note);
		next();
	}

	function next() {
		numberDraft = '';
		// правили один пункт — возвращаемся к сводке, а не идём дальше по списку
		if (back !== null) {
			backToSummary();
			return;
		}
		index += 1;
		// последний пункт закрыт — подготовка считается пройденной (ФТ-5.7)
		if (index >= items.length && flight) markPrepared(flight.id);
	}

	function openNote() {
		noteDraft = item.note;
		noteOpen = true;
	}

	function saveNote() {
		items[index].note = noteDraft.trim();
		if (run) answerItem(run, items[index].id, items[index].value, items[index].note);
		noteOpen = false;
	}

	/** Переделка проверки: прежнее прохождение сохраняется с причиной (ФТ-6.9) */
	function restart() {
		// аннулируется последнее прохождение, в том числе подписанное: иначе
		// после подписи проверка пошла бы мимо протокола (ФТ-6.9)
		const previous = flight ? runFor(flight.id) : undefined;
		if (previous) voidRun(previous, 'Проверка пройдена заново');
		begin();
	}

	/** Сводка перед завершением: сколько заполнено, пропущено и отрицательных (ФТ-6.10) */
	const summary = $derived.by(() => ({
		filled: items.filter((i) => i.value !== null).length,
		skipped: items.filter((i) => i.value === null).length,
		failed: items.filter((i) => i.value === false).length,
		notes: items.filter((i) => i.note !== '').length
	}));
</script>

<!--
	На телефоне экран разъезжается по краям: заголовок с вопросом вверху,
	кнопки внизу — до них дотягивается большой палец руки, которой держат
	планшет или телефон, и не приходится перехватывать его на площадке.
	Делает это `mb-auto` у заголовка: свободная высота уходит между ним
	и остальным, а не под кнопки. На настольном экране тянуть нечего,
	и всё возвращается к обычному потоку.
-->
<section
	class="mx-auto flex min-h-[calc(100dvh_-_6rem)] w-full max-w-2xl flex-col gap-5 md:min-h-0 [&>header]:mb-auto md:[&>header]:mb-0"
>
	{#if !checklist}
		<p class="py-8 text-center text-text-muted">
			{flight ? 'Для этого борта нет чеклиста' : 'Выберите полёт в списке планируемых'}
		</p>
	{:else if stage === 'полёт'}
		<header class="flex flex-col items-center gap-2 rounded-lg border bg-front p-4">
			<span class="text-sm text-text-muted">{flight?.aircraft} · взлёт в {flight?.takeoff}</span>
			<!-- крупные цифры: время видно на вытянутой руке -->
			<p class="text-6xl text-accent tabular-nums">{elapsed}</p>
			<Tag level="live">в полёте</Tag>
		</header>

		{#if mayFly}
			<button
				class="{BTN} border-heat-bad bg-heat-bad/15 text-heat-bad"
				onclick={() => flight && finishFlight(flight.id)}
			>
				Посадка
			</button>
		{/if}
	{:else if stage === 'итог'}
		<header class="flex flex-col items-center gap-2 rounded-lg border bg-front p-4">
			<h3 class="text-2xl">Полёт завершён</h3>
			<p class="text-text-muted">{flight?.aircraft}</p>
		</header>

		<dl class="grid grid-cols-2 gap-y-2 rounded-lg border bg-front p-4 text-lg">
			<dt class="text-text-muted">Взлёт</dt>
			<dd class="text-right tabular-nums">{flight?.takeoff || '—'}</dd>
			<dt class="text-text-muted">Посадка</dt>
			<dd class="text-right tabular-nums">{flight?.landing || '—'}</dd>
			<dt class="text-text-muted">Налёт</dt>
			<dd class="text-right tabular-nums">{duration(flight?.duration ?? 0)}</dd>
			<dt class="text-text-muted">Примечаний в проверке</dt>
			<dd class="text-right tabular-nums">{summary.notes}</dd>
		</dl>

		<a href="/plan" class="{BTN} border-accent bg-accent/15 text-center text-accent">
			К списку полётов
		</a>
	{:else if checking && items.length === 0}
		<p class="py-8 text-center text-text-muted">В чеклисте нет пунктов</p>
	{:else if checking && !done}
		<header class="flex flex-col items-center gap-2 rounded-lg border bg-front p-4">
			<!-- название чеклиста рядом со счётчиком: на площадке проверку начинают
			     не с начала экрана, и «по какому чеклисту иду» — первый вопрос,
			     который возникает у того, кто подошёл к борту -->
			<span class="text-center text-sm {fixing ? 'text-accent' : 'text-text-muted'}">
				{checklist.title} · {fixing ? 'Правка пункта' : 'Пункт'}
				{index + 1} из {items.length}
			</span>
			<h3 class="text-center text-2xl">{item.title}</h3>
			<!-- пояснение к пункту — обычный текст: акцентом в приложении отмечено
			     то, что нажимают, а это просто продолжение вопроса -->
			{#if item.hint}<p class="text-center">{item.hint}</p>{/if}
		</header>

		{#if item.kind === 'да/нет'}
			<button
				class="{BTN} border-heat-bad bg-heat-bad/15 text-heat-bad"
				onclick={() => answer(false)}
			>
				Не соответствует
			</button>
			<button class="{BTN} border-accent bg-accent/15 text-accent" onclick={() => answer(true)}>
				Соответствует требованию
			</button>
		{:else if item.kind === 'число'}
			<label class="flex flex-col gap-2">
				<span class="text-text-muted">
					Допустимо: {item.min}–{item.max}{item.unit ? ' ' + item.unit : ''}
				</span>
				<input
					type="number"
					inputmode="decimal"
					bind:value={numberDraft}
					class="min-h-touch-lg rounded-lg border px-3 text-2xl tabular-nums"
					class:border-heat-bad={outOfRange}
					class:text-heat-bad={outOfRange}
				/>
			</label>
			{#if outOfRange}
				<!-- за пределами диапазона пункт не запрещает вылет, но просит пояснить (ФТ-6.5) -->
				<p class="text-heat-bad">Значение вне допустимого диапазона — добавьте примечание</p>
			{/if}
			<button
				class="{BTN} border-accent bg-accent/15 text-accent disabled:opacity-40"
				disabled={numberDraft === ''}
				onclick={() => answer(Number(numberDraft))}
			>
				Записать значение
			</button>
		{:else if item.kind === 'выбор'}
			{#each item.options ?? [] as option (option)}
				<button class="{BTN} border-accent bg-accent/15 text-accent" onclick={() => answer(option)}>
					{option}
				</button>
			{/each}
		{:else if item.kind === 'текст'}
			<textarea
				rows="4"
				bind:value={numberDraft}
				class="rounded-lg border p-3 text-lg"
				placeholder="Опишите результат"></textarea>
			<button
				class="{BTN} border-accent bg-accent/15 text-accent disabled:opacity-40"
				disabled={numberDraft.trim() === ''}
				onclick={() => answer(numberDraft.trim())}
			>
				Записать
			</button>
		{/if}

		<button class="{BTN} border-border text-text-muted" onclick={openNote}>
			{item.note ? 'Примечание добавлено' : 'Добавить примечание'}
		</button>

		{#if fixing}
			<!-- правили примечание, а ответ менять не стали: возврат отдельной кнопкой -->
			<button class="{BTN} border-accent text-accent" onclick={backToSummary}>
				Вернуться, не меняя ответ
			</button>
		{/if}
	{:else if checking}
		<!-- завершение проверки: подпись закрывает протокол и не является
		     пунктом чеклиста — подписывают проверку целиком, а не строку в ней -->
		<header class="flex flex-col items-center gap-2 rounded-lg border bg-front p-4">
			<h3 class="text-2xl">Проверка пройдена</h3>
			<p class="text-center text-text-muted">{checklist.title}, версия {checklist.version}</p>
		</header>

		<!-- обязательные параметры прохождения: заполняются сами, кроме погоды (ФТ-6.8) -->
		<dl class="grid grid-cols-2 gap-y-2 rounded-lg border bg-front p-4">
			{#each heading as row (row.label)}
				<dt class="text-text-muted">{row.label}</dt>
				<dd class="text-right">{row.value}</dd>
			{/each}
		</dl>

		<dl class="grid grid-cols-2 gap-y-2 rounded-lg border bg-front p-4 text-lg">
			<dt class="text-text-muted">Заполнено</dt>
			<dd class="text-right tabular-nums">{summary.filled} из {items.length}</dd>
			<dt class="text-text-muted">Пропущено</dt>
			<dd class="text-right tabular-nums">{summary.skipped}</dd>
			<dt class="text-text-muted">Не соответствует</dt>
			<dd class="text-right tabular-nums">{summary.failed}</dd>
			<dt class="text-text-muted">Примечаний</dt>
			<dd class="text-right tabular-nums">{summary.notes}</dd>
		</dl>

		<!-- перед подписью пилот видит, что именно он подтверждает (ФТ-6.10),
		     и может открыть любой пункт на правку — нажатием по строке -->
		<div class="flex flex-col rounded-lg border bg-front p-4">
			<p class="pb-2 text-sm text-text-muted">Нажмите на пункт, чтобы исправить ответ</p>
			{#each items as row, at (row.id)}
				<button
					type="button"
					class="click flex min-h-touch justify-between gap-3 border-b py-2 text-left last:border-b-0"
					onclick={() => revisit(at)}
				>
					<span class="text-text-muted">{row.title}</span>
					<span
						class="shrink-0 text-right"
						class:text-heat-bad={row.value === false}
						class:text-text-muted={row.value === null}
					>
						{shown(row)}
						{#if row.note}
							<span class="block text-sm text-text-muted">{row.note}</span>
						{/if}
					</span>
				</button>
			{/each}
		</div>

		<label class="flex flex-col gap-2">
			<span class="text-text-muted">Описание проверки</span>
			<textarea
				rows="3"
				bind:value={describe}
				class="rounded-lg border p-3 text-lg"
				placeholder="Что стоит знать об этой подготовке"></textarea>
		</label>

		<p class="text-center text-text-muted">
			Подпись фиксирует ФИО, дату, время и координаты: {me.name}
		</p>
		<button class="{BTN} border-accent bg-accent/15 text-accent" onclick={sign}>
			Подписать и завершить
		</button>
	{:else if stage === 'взлёт'}
		<header class="flex flex-col items-center gap-2 rounded-lg border bg-front p-4">
			<h3 class="text-2xl">Готов к вылету</h3>
			<p class="text-center text-text-muted">
				{flight?.aircraft} · {flight?.site || 'площадка не задана'}
			</p>
			<p class="text-center text-text-muted">Подготовка пройдена, борт можно поднимать</p>
		</header>

		{#if mayFly}
			<button
				class="{BTN} border-accent bg-accent/15 text-accent"
				onclick={() => flight && startFlight(flight.id)}
			>
				Взлёт
			</button>
		{:else}
			<p class="text-center text-text-muted">Полёт записан за другим пилотом — взлёт отмечает он</p>
		{/if}

		{#if mayCheck}
			<button class="{BTN} border-border text-text-muted" onclick={restart}>
				Пройти чеклист заново
			</button>
		{/if}
	{:else}
		<!-- шаг «выбор чеклиста»: пилот видит, по чему будет проверять, до начала -->
		<header class="flex flex-col items-center gap-2 rounded-lg border bg-front p-4">
			<span class="text-sm text-text-muted">
				{showDate(flight?.date ?? '')} · {flight?.takeoff || 'время не задано'}
			</span>
			<h3 class="text-center text-2xl">{flight?.aircraft}</h3>
			<p class="text-center text-accent">{flight?.site || 'площадка не задана'}</p>
		</header>

		<dl class="grid grid-cols-2 gap-y-2 rounded-lg border bg-front p-4">
			<dt class="text-text-muted">Чеклист</dt>
			<dd class="text-right">{checklist.title}</dd>
			<dt class="text-text-muted">Версия</dt>
			<dd class="text-right tabular-nums">{checklist.version}</dd>
			<dt class="text-text-muted">Пунктов</dt>
			<dd class="text-right tabular-nums">{items.length}</dd>
			<dt class="text-text-muted">Источник</dt>
			<dd class="text-right">{checklist.aircraftId ? 'чеклист борта' : 'шаблон модели'}</dd>
		</dl>

		<label class="flex flex-col gap-2">
			<span class="flex items-center justify-between gap-3 text-text-muted">
				<span>
					Погода на площадке
					{#if spot}· {spot.lat}, {spot.lon}{/if}
				</span>
				<button
					class="click min-h-0 rounded-sm border px-2 py-1 text-sm"
					disabled={sensing}
					onclick={sense}
				>
					{sensing ? 'Определяем…' : 'Определить'}
				</button>
			</span>

			<input
				bind:value={weather}
				class="min-h-touch rounded-lg border px-3 text-lg"
				placeholder="Ветер, температура, осадки"
			/>

			{#if sensorError}
				<!-- автоматика не сработала: параметр обязателен, источник — нет -->
				<span class="text-sm text-heat-bad">{sensorError} — заполните вручную</span>
			{/if}
		</label>

		{#if mayCheck}
			<button
				class="{BTN} border-accent bg-accent/15 text-accent disabled:opacity-40"
				disabled={weather.trim() === ''}
				onclick={begin}
			>
				Начать проверку
			</button>
		{:else}
			<!-- проверку проводит тот, кто полетит (ФТ-6) -->
			<p class="text-center text-text-muted">
				Предполётную подготовку проводит пилот. Ваши роли дают только просмотр.
			</p>
		{/if}
	{/if}
</section>

<Modal bind:show={noteOpen} title="Примечание">
	<div class="flex flex-col gap-3">
		{#if item?.notes?.length}
			<!-- заготовки: в перчатках проще ткнуть в готовую фразу, чем набирать -->
			<p class="text-sm text-text-muted">Частые примечания</p>
			{#each item.notes as ready (ready)}
				<button
					class="click min-h-0 rounded-sm border p-2 text-left text-sm text-text-muted"
					onclick={() => (noteDraft = ready)}
				>
					{ready}
				</button>
			{/each}
		{/if}

		<textarea
			rows="3"
			bind:value={noteDraft}
			class="rounded-sm p-2 text-sm"
			placeholder="Своё примечание"></textarea>

		<button
			class="click min-h-0 self-end rounded-sm border border-accent bg-accent/15 px-3 py-1.5 text-accent"
			onclick={saveNote}
		>
			Сохранить
		</button>
	</div>
</Modal>
