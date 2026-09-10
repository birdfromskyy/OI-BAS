<script lang="ts">
	import { page } from '$app/state';
	import { accessTokenFromURL, rememberAccessToken } from '$lib/api';

	const token = $derived(accessTokenFromURL(page.url.toString()));
	function enter() {
		if (!token) return;
		// Токен сохраняется и для текущей вкладки, и для устройства. Полная
		// загрузка не оставляет в памяти старый профиль во время bootstrap.
		rememberAccessToken(token);
		location.replace('/');
	}
</script>

<section class="mx-auto flex w-full max-w-2xl flex-col gap-5 py-6">
	<header class="flex flex-col items-center gap-2 rounded-lg border bg-front p-6">
		<h2 class="text-2xl">Вход по ссылке</h2>
		<p class="text-center text-text-muted">
			Пароль не нужен. Эта ссылка действует, пока администратор её не отзовёт.
		</p>
	</header>
	{#if token}
		<button
			class="click min-h-touch-lg rounded-lg border border-accent bg-accent/15 p-3 text-lg text-accent"
			onclick={enter}>Открыть приложение</button
		>
	{:else}
		<p class="rounded-lg border bg-front p-4 text-center text-text-muted">
			Ссылка неполная или отозвана. Попросите администратора выдать новую.
		</p>
	{/if}
</section>
