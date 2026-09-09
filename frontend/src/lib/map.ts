import type { StyleSpecification } from 'maplibre-gl';

/**
 * Подложка карты.
 *
 * Вынесена в одно место намеренно: подложка — единственная часть приложения,
 * которая ходит наружу, и при развёртывании в контуре заказчика (ФТ-18)
 * её меняют первой. Остальной код про карты о провайдере ничего не знает.
 *
 * Тайлы векторные, а не картинками: цвета задаёт стиль ниже, а не поставщик,
 * поэтому карта окрашена палитрой приложения, а не «тёмной темой провайдера».
 * Тот же стиль будет работать поверх своего файла .pmtiles, когда подложку
 * положат рядом с приложением — поменяется только адрес источника.
 *
 * Почему не Яндекс и не Google: у них не тайлы по адресу, а собственный SDK
 * с ключом, который проверяется через интернет. Это другой способ подключения,
 * подмена подложки их условиями запрещена, и на площадке без сети он не
 * работает вовсе (НФТ-1.1).
 */

/** Векторные тайлы OpenStreetMap без ключа и регистрации */
export const TILES = 'https://tiles.openfreemap.org/planet';

/** Шрифты подписей отдаются тем же сервисом */
const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';

/**
 * Цвета — те же токены, что у приложения (см. routes/layout.css). Карта не
 * должна выглядеть вставкой из чужого продукта: фон совпадает с фоном панели,
 * вода и дороги набраны из соседних оттенков, а единственный яркий цвет
 * оставлен точкам вылетов — иначе их не найти среди подписей.
 */
const BG = '#0f131e';
const LAND = '#141a27';
const PARK = '#152218';
const WATER = '#16243a';
const BUILDING = '#1b2334';
const ROAD = '#30363D';
const ROAD_MAJOR = '#3c4450';
const BORDER = '#3a4356';
const LABEL = '#99a3b8';

/** Подпись места на русском, если она есть в данных */
const NAME = ['coalesce', ['get', 'name:ru'], ['get', 'name']];

export function darkStyle(): StyleSpecification {
	return {
		version: 8,
		glyphs: GLYPHS,
		sources: {
			osm: {
				type: 'vector',
				url: TILES,
				attribution: '© OpenStreetMap, OpenFreeMap'
			}
		},
		layers: [
			{ id: 'bg', type: 'background', paint: { 'background-color': BG } },
			{
				id: 'landcover',
				type: 'fill',
				source: 'osm',
				'source-layer': 'landcover',
				paint: { 'fill-color': LAND, 'fill-opacity': 0.6 }
			},
			{
				id: 'park',
				type: 'fill',
				source: 'osm',
				'source-layer': 'park',
				paint: { 'fill-color': PARK, 'fill-opacity': 0.6 }
			},
			{
				id: 'water',
				type: 'fill',
				source: 'osm',
				'source-layer': 'water',
				paint: { 'fill-color': WATER }
			},
			{
				id: 'waterway',
				type: 'line',
				source: 'osm',
				'source-layer': 'waterway',
				paint: {
					'line-color': WATER,
					'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 16, 3]
				}
			},
			{
				id: 'building',
				type: 'fill',
				source: 'osm',
				'source-layer': 'building',
				minzoom: 13,
				paint: { 'fill-color': BUILDING, 'fill-opacity': 0.7 }
			},
			{
				// мелкие дороги появляются поздно: на обзорном масштабе они
				// превращают карту в сетку и прячут точки вылетов
				id: 'road-minor',
				type: 'line',
				source: 'osm',
				'source-layer': 'transportation',
				minzoom: 12,
				filter: ['match', ['get', 'class'], ['minor', 'service', 'track', 'path'], true, false],
				paint: {
					'line-color': ROAD,
					'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.4, 18, 4]
				}
			},
			{
				id: 'road-major',
				type: 'line',
				source: 'osm',
				'source-layer': 'transportation',
				filter: [
					'match',
					['get', 'class'],
					['primary', 'secondary', 'tertiary', 'trunk', 'motorway'],
					true,
					false
				],
				paint: {
					'line-color': ROAD_MAJOR,
					'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.6, 12, 2, 18, 8]
				}
			},
			{
				id: 'boundary',
				type: 'line',
				source: 'osm',
				'source-layer': 'boundary',
				filter: ['<=', ['get', 'admin_level'], 4],
				paint: { 'line-color': BORDER, 'line-width': 1, 'line-dasharray': [3, 2] }
			},
			{
				id: 'place',
				type: 'symbol',
				source: 'osm',
				'source-layer': 'place',
				filter: ['match', ['get', 'class'], ['city', 'town', 'village', 'suburb'], true, false],
				layout: {
					'text-field': NAME,
					'text-font': ['Noto Sans Regular'],
					'text-size': ['interpolate', ['linear'], ['zoom'], 6, 11, 12, 15],
					'text-max-width': 8
				},
				paint: { 'text-color': LABEL, 'text-halo-color': BG, 'text-halo-width': 1.2 }
			},
			{
				id: 'water-name',
				type: 'symbol',
				source: 'osm',
				'source-layer': 'water_name',
				layout: {
					'text-field': NAME,
					'text-font': ['Noto Sans Regular'],
					'text-size': 11
				},
				paint: { 'text-color': LABEL, 'text-halo-color': BG, 'text-halo-width': 1 }
			}
		]
	} as StyleSpecification;
}
