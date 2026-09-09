<script module lang="ts">
	/** Точка на карте: вылет, площадка, место проверки */
	export type MapPoint = {
		id: string;
		lat: number;
		lon: number;
		label: string;
		/** Подробности под заголовком окна точки: по строке на каждую */
		lines?: string[];
		/** Выделенная точка: крупнее и в акценте, остальные приглушены */
		active?: boolean;
	};
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import 'maplibre-gl/dist/maplibre-gl.css';
	/**
	 * Веб-воркер карты собирается отдельным файлом, а не берётся у библиотеки:
	 * она ищет его рядом с собой, а в сборке её код лежит в общем чанке, где
	 * этого файла нет. Простого `?url` мало — файл воркера сам импортирует
	 * соседний maplibre-gl-shared.mjs, и тот в сборку не попадает: в браузере
	 * это 404 и пустая карта без объяснений. С `?worker&url` воркер собирается
	 * со своими зависимостями в один файл, отдаётся со своего домена
	 * и кэшируется service worker'ом при первом показе карты.
	 */
	import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
	import type { Map as GLMap, GeoJSONSource, ExpressionSpecification } from 'maplibre-gl';
	import { hasPoint, mapLink, sppi, type Point } from '$lib/components/format';
	import { darkStyle } from '$lib/map';

	/**
	 * Карта точки: где взлетали, где проходили проверку, куда планируют.
	 *
	 * Координаты — то, что хранится и подписывается; карта только показывает
	 * их и помогает поставить точку, поэтому она не имеет права быть условием
	 * работы. Подложка приходит из сети, а предполётная подготовка идёт там,
	 * где сети нет (НФТ-1.1), — значит без подложки карта обязана
	 * деградировать до координат и ссылки в стороннее приложение карт.
	 *
	 * Тайлы векторные: цвета задаёт наш стиль ($lib/map), а не поставщик,
	 * поэтому карта окрашена палитрой приложения.
	 */
	let {
		lat = 0,
		lon = 0,
		points = [],
		zoom = 14,
		height = '14rem',
		/** Задан — точку можно поставить нажатием: планирование площадки (ФТ-5.4) */
		onpick,
		/** Задан — нажатие по точке открывает запись, ради которой она на карте */
		onpoint,
		/** Курсор над точкой: id записи, null — курсор ушёл с точки */
		onover
	}: {
		lat?: number;
		lon?: number;
		/**
		 * Несколько точек вместо одной: карта вылетов на панели. Задан — карта
		 * показывает их все и подводит вид к выделенным; пуст — работает
		 * одиночная точка из lat/lon.
		 */
		points?: MapPoint[];
		zoom?: number;
		height?: string;
		onpick?: (point: Point) => void;
		onpoint?: (id: string) => void;
		onover?: (id: string | null) => void;
	} = $props();

	let box = $state<HTMLDivElement>();
	let map: GLMap | undefined;
	let ready = $state(false);
	/**
	 * Что пошло не так при запуске карты. Пустая карта без объяснения —
	 * худший исход: непонятно, чинить сеть, стиль или разметку, — поэтому
	 * ошибка и затянувшийся запуск показываются текстом под картой.
	 */
	let failed = $state('');

	const many = $derived(points.length > 0);
	const known = $derived(many || hasPoint(lat, lon));
	/** Выделенные точки: к ним подводится вид при наведении на день календаря */
	const chosen = $derived(points.filter((p) => p.active));

	/**
	 * height: '100%' означает «занять всё, что осталось». Проценту не от чего
	 * считаться в колонке, высота которой задана содержимым, поэтому вместо
	 * процента карта становится растягивающимся элементом колонки.
	 */
	const fill = $derived(height === '100%');

	/** Жёлтый подсветки — тот же, которым помечено «обрати внимание» в палитре */
	const HOT = '#E8A317';

	/** Куда смотреть, пока точки нет: центр области, а не нулевой меридиан */
	const HOME: Point = { lat: 57.1522, lon: 65.5272 };

	/** Точки одним набором: одиночная и множественная работают одинаково */
	const shown = $derived<MapPoint[]>(
		many
			? points
			: hasPoint(lat, lon)
				? [{ id: 'one', lat, lon, label: sppi(lat, lon), active: true }]
				: []
	);

	function collection() {
		return {
			type: 'FeatureCollection' as const,
			features: shown.map((p) => ({
				type: 'Feature' as const,
				geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] },
				// свойства точки переживают дорогу до слоя только строками и числами:
				// список подробностей склеиваем, а id несём, чтобы по нажатию было
				// понятно, о какой записи речь
				properties: {
					id: p.id,
					label: p.label,
					lines: (p.lines ?? []).join('\n'),
					active: p.active === true
				}
			}))
		};
	}

	onMount(() => {
		let alive = true;
		let cleanup = () => {};

		// карта не поднялась за пять секунд — говорим об этом, а не молчим
		const slow = setTimeout(() => {
			if (!ready) failed = 'Карта не загрузилась. Проверьте сеть и консоль браузера.';
		}, 5000);

		(async () => {
			try {
				const maplibre = await import('maplibre-gl');
				if (!alive || !box) return;

				/**
				 * Адрес воркера задаётся явно, до создания карты. Сама библиотека
				 * ищет его рядом с собой — `new URL('./maplibre-gl-worker.mjs',
				 * import.meta.url)`, — а в собранном приложении её код лежит
				 * в общем чанке, где этого файла нет: воркер не поднимается,
				 * и карта остаётся пустой. В разработке файл лежит рядом
				 * с библиотекой, поэтому там всё работало и без этой строки.
				 */
				maplibre.setWorkerUrl(workerUrl);

				const start = shown.find((p) => p.active) ?? shown[0] ?? HOME;
				map = new maplibre.Map({
					container: box,
					style: darkStyle(),
					center: [start.lon, start.lat],
					zoom: many ? 9 : known ? zoom : 9,
					attributionControl: { compact: true }
				});

				map.addControl(new maplibre.NavigationControl({ showCompass: false }), 'top-right');

				map.on('load', () => {
					if (!map) return;
					// promoteId: без него у точки нет опознавателя, а состояние
					// наведения хранится именно по нему
					map.addSource('dots', {
						type: 'geojson',
						data: collection(),
						promoteId: 'id'
					});

					/**
					 * Точка под курсором — не отдельная точка поверх старой, а та же
					 * самая, нарисованная иначе: размер и цвет берутся выражением
					 * от состояния наведения. Отдельным слоем мелкая точка осталась
					 * бы торчать из-под крупной.
					 */
					const hot: ExpressionSpecification = ['boolean', ['feature-state', 'hot'], false];
					const when = (yes: string | number, no: string | number): ExpressionSpecification => [
						'case',
						hot,
						yes,
						no
					];

					// две прослойки вместо одной: выделенная точка отличается размером
					// и цветом, а не только цветом — так её видно и при дальтонизме
					map.addLayer({
						id: 'dots-dim',
						type: 'circle',
						source: 'dots',
						filter: ['!', ['get', 'active']],
						paint: {
							'circle-radius': when(9, 5),
							'circle-color': when(HOT, '#99a3b8'),
							'circle-opacity': when(0.55, 0.35),
							'circle-stroke-width': when(3, 2),
							'circle-stroke-color': when(HOT, '#99a3b8')
						}
					});
					map.addLayer({
						id: 'dots-active',
						type: 'circle',
						source: 'dots',
						filter: ['get', 'active'],
						paint: {
							'circle-radius': 9,
							'circle-color': when(HOT, '#F97316'),
							'circle-opacity': when(0.55, 0.45),
							'circle-stroke-width': 3,
							'circle-stroke-color': when(HOT, '#F97316')
						}
					});

					const popup = new maplibre.Popup({
						closeButton: false,
						closeOnClick: false,
						offset: 14,
						// своё оформление: тёмное окно с белым текстом вместо белого
						// пузыря по умолчанию — карта тоже тёмная (стили в конце файла)
						className: 'map-note'
					});

					/** Какая точка сейчас под курсором: снять состояние с прежней */
					let under: string | null = null;

					function light(id: string | null) {
						if (id === under) return;
						if (under !== null) map?.setFeatureState({ source: 'dots', id: under }, { hot: false });
						if (id !== null) map?.setFeatureState({ source: 'dots', id }, { hot: true });
						under = id;
						onover?.(id);
					}

					for (const layer of ['dots-dim', 'dots-active']) {
						// mousemove, а не mouseenter: между двумя соседними точками
						// одного слоя курсор проходит без «входа» заново, и подсветка
						// с окном оставались бы на первой
						map.on('mousemove', layer, (e) => {
							if (!map) return;
							map.getCanvas().style.cursor = 'pointer';
							const f = e.features?.[0];
							if (!f) return;

							// точка под курсором подсвечивается жёлтым, а день этого
							// полёта — той же подсветкой в календаре рядом
							light(String(f.properties?.id ?? ''));

							popup
								.setLngLat(e.lngLat)
								.setDOMContent(
									note(String(f.properties?.label ?? ''), String(f.properties?.lines ?? ''))
								)
								.addTo(map);
						});
						map.on('mouseleave', layer, () => {
							if (map) map.getCanvas().style.cursor = onpick ? 'crosshair' : '';
							light(null);
							popup.remove();
						});
					}

					ready = true;
					failed = '';
					clearTimeout(slow);
					frame();
				});

				if (onpoint) {
					// нажатие по точке открывает запись, ради которой она на карте
					for (const id of ['dots-dim', 'dots-active']) {
						map.on('click', id, (e) => {
							const point = e.features?.[0];
							if (point) onpoint(String(point.properties?.id ?? ''));
						});
					}
				}

				if (onpick) {
					map.getCanvas().style.cursor = 'crosshair';
					map.on('click', (e) => {
						// щелчок пришёлся на точку — это переход к записи, а не выбор
						// нового места: иначе одно нажатие означало бы два действия
						const hit = map?.queryRenderedFeatures(e.point, {
							layers: ['dots-dim', 'dots-active']
						});
						if (hit && hit.length > 0) return;
						onpick({ lat: +e.lngLat.lat.toFixed(4), lon: +e.lngLat.lng.toFixed(4) });
					});
				}

				/**
				 * Карта появляется внутри модального окна, которое ещё открывается,
				 * и растягивается вместе с колонкой панели. Разовый пересчёт этого
				 * не закрывает, поэтому следим за размером всё время жизни.
				 */
				const watch = new ResizeObserver(() => map?.resize());
				watch.observe(box);

				cleanup = () => {
					watch.disconnect();
					map?.remove();
					map = undefined;
				};
			} catch (e) {
				failed = e instanceof Error ? e.message : 'Карта не запустилась';
			}
		})();

		return () => {
			alive = false;
			clearTimeout(slow);
			cleanup();
		};
	});

	/**
	 * Содержимое окна точки. Собирается узлами, а не разметкой строкой:
	 * внутри названия площадок и примечания пилота — текст, введённый
	 * человеком, и вставлять его как HTML нельзя.
	 */
	function note(label: string, lines: string): HTMLElement {
		const box = document.createElement('div');
		box.style.display = 'flex';
		box.style.flexDirection = 'column';
		box.style.gap = '2px';

		const head = document.createElement('strong');
		head.textContent = label;
		box.append(head);

		for (const line of lines.split('\n').filter(Boolean)) {
			const row = document.createElement('span');
			row.textContent = line;
			box.append(row);
		}
		return box;
	}

	/** Подвести вид к выделенным точкам, а если их нет — ко всем */
	function frame() {
		if (!map || !ready || shown.length === 0) return;
		const look = chosen.length > 0 ? chosen : shown;

		if (look.length === 1) {
			map.easeTo({ center: [look[0].lon, look[0].lat], zoom: Math.max(map.getZoom(), zoom) });
			return;
		}

		const west = Math.min(...look.map((p) => p.lon));
		const east = Math.max(...look.map((p) => p.lon));
		const south = Math.min(...look.map((p) => p.lat));
		const north = Math.max(...look.map((p) => p.lat));
		map.fitBounds(
			[
				[west, south],
				[east, north]
			],
			{ padding: 48, maxZoom: 13 }
		);
	}

	// точки и выделение приходят снаружи: наведение на день календаря,
	// выбор площадки в карточке полёта
	$effect(() => {
		const data = collection();
		if (!map || !ready) return;
		(map.getSource('dots') as GeoJSONSource | undefined)?.setData(data);
		frame();
	});
</script>

<!-- min-w-0 обязателен: карта живёт в ячейке сетки, а ячейка по умолчанию
     не сжимается меньше содержимого — карта раздвигала бы ею всё окно -->
<div class={['flex w-full min-w-0 flex-col gap-2', fill && 'min-h-0 flex-1']}>
	<div
		bind:this={box}
		class={[
			'w-full min-w-0 overflow-hidden  bg-bg',
			// нижняя граница обязательна: если разметка вокруг не даст высоты,
			// карта схлопнется в ноль и это выглядит как «ничего не работает»
			fill && 'min-h-80 flex-1'
		]}
		style={fill ? 'max-width: 100%' : `height: ${height}; max-width: 100%`}
		role="application"
		aria-label="Карта точки"
	></div>

	{#if known && !many}
		<!-- у стороннего приложения карт свои офлайн-карты: на площадке
		     без сети это единственный способ увидеть местность -->
		<a
			href={mapLink(lat, lon)}
			class="click self-start rounded-sm border px-2 py-1 text-sm text-text-muted"
		>
			Открыть в картах
		</a>
	{/if}

	{#if failed}
		<!-- единственное, что осталось под картой из сообщений: ошибка запуска.
		     Пустая карта без объяснения — это «ничего не работает», и молчать
		     здесь нельзя. Подсказки и состояние сети убраны намеренно -->
		<p class="text-sm text-heat-bad">{failed}</p>
	{/if}
</div>

<style>
	/**
	 * Окно точки: чёрный фон и белый текст. Оформление задаётся через :global —
	 * разметку окна создаёт библиотека, и до неё не доходят ни классы Tailwind,
	 * ни областная разметка Svelte. Хвостик пузыря красится по всем четырём
	 * сторонам: какая из них рисуется, зависит от того, куда окну хватило места.
	 */
	:global(.map-note .maplibregl-popup-content) {
		background: #000;
		color: #fff;
		border-radius: 6px;
		padding: 8px 10px;
		font-size: 13px;
		line-height: 1.35;
		box-shadow: 0 6px 18px rgb(0 0 0 / 0.45);
	}

	:global(.map-note .maplibregl-popup-tip) {
		border-top-color: #000;
		border-bottom-color: #000;
		border-left-color: #000;
		border-right-color: #000;
	}
</style>
