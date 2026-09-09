/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />
import { build, files, version } from '$service-worker';

/**
 * Офлайн-режим (НФТ-1.1, НФТ-1.10).
 *
 * Приложение должно открываться и работать на площадке без связи: пилот
 * проходит чеклист, поднимает борт и закрывает полёт, а записи уходят на
 * сервер потом. Для этого код и разметка кладутся в кэш при установке,
 * а страницы отдаются из сети с откатом на кэш.
 */
const sw = self as unknown as ServiceWorkerGlobalScope;

/** Имя кэша содержит версию сборки: новая сборка не подмешивается к старой */
const CACHE = `экипаж-${version}`;

/**
 * Собственные файлы приложения: код, стили, шрифты, иконки.
 *
 * Воркера карты здесь нет намеренно: его собирает Vite отдельным файлом,
 * в `build` он не попадает, а взять его адрес импортом нельзя — в сборке
 * service worker он считается от другого корня и превращается в неверный
 * путь, на котором падает всё предварительное кэширование. Воркер попадает
 * в кэш при первом открытии карты, правилом для остальных запросов ниже.
 */
const ASSETS = [...build, ...files];

/** Пустая оболочка приложения: с неё поднимается любой маршрут */
const SHELL = '/';

sw.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			// оболочка кладётся вместе с файлами: без серверного рендера она одна
			// на все маршруты, и офлайн с неё открывается любой экран
			.then((cache) => cache.addAll([...ASSETS, SHELL]))
			// новая версия не ждёт закрытия вкладок: на площадке перезапускать некому
			.then(() => sw.skipWaiting())
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
			.then(() => sw.clients.claim())
	);
});

sw.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.method !== 'GET') return;

	const url = new URL(request.url);
	if (url.origin !== location.origin) return;

	// Файлы сборки неизменяемы: их всегда берём из кэша, не трогая сеть
	if (ASSETS.includes(url.pathname)) {
		event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request)));
		return;
	}

	/**
	 * Переходы по страницам: сначала сеть, потом оболочка из кэша. Разметка
	 * у всех маршрутов одна, поэтому подходит любая — дальше маршрут разберёт
	 * клиентский роутер, а данные возьмутся с устройства.
	 */
	if (request.mode === 'navigate') {
		event.respondWith(
			fetch(request).catch(async () => {
				const shell = await caches.match(SHELL);
				return shell ?? Response.error();
			})
		);
		return;
	}

	/**
	 * Остальные запросы — данные маршрутов и прочая мелочь. Кэш здесь только
	 * запасной: подсовывать разметку вместо ответа нельзя, иначе приложение
	 * получит HTML там, где ждёт JSON, и упадёт.
	 */
	event.respondWith(
		fetch(request)
			.then((res) => {
				if (res.ok && res.type === 'basic') {
					const copy = res.clone();
					caches.open(CACHE).then((cache) => cache.put(request, copy));
				}
				return res;
			})
			.catch(async () => (await caches.match(request)) ?? Response.error())
	);
});
