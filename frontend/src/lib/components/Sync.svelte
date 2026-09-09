<script lang="ts">
	import Tag from '$lib/components/Tag.svelte';
	import { blocked, flush, net, pending, retryBlocked } from '$lib/sync.svelte';

	/**
	 * Состояние связи и очереди отправки.
	 *
	 * Пилоту важно видеть не «интернет пропал», а «мои записи целы и уйдут»:
	 * работа на площадке не прерывается, поэтому индикатор показывает,
	 * сколько записей ждёт отправки, и позволяет отправить их вручную.
	 */
	const waiting = $derived(pending().length);
	const conflicts = $derived(blocked().length);
</script>

<!-- размер «md»: плашка стоит в шапке рядом с кнопками меню и обязана быть
     с них ростом, иначе разнобой читается как поломка -->
{#if !net.online}
	<Tag level="warn" size="md">
		Нет сети{waiting > 0 ? ` · ${waiting} в очереди` : ''}
	</Tag>
{:else if conflicts > 0}
	<!-- Автоматически чужую версию не перезаписываем. После просмотра данных
	     пользователь может повторить попытку только явным нажатием. -->
	<Tag
		level="bad"
		size="md"
		title={net.error || 'Требуется разрешить конфликт'}
		onclick={retryBlocked}
	>
		Конфликт · {conflicts}
	</Tag>
{:else if net.sending}
	<Tag level="info" size="md">Отправка…</Tag>
{:else if waiting > 0}
	<Tag level="info" size="md" onclick={flush}>Отправить {waiting}</Tag>
{/if}

<!-- «Синхронизировано» в шапке не показывается: когда всё отправлено,
     сообщать не о чем, а постоянная плашка перестаёт читаться и заодно
     обесценивает соседнюю — ту, из-за которой сюда и смотрят -->
