<script lang="ts">
	import Table from '$lib/components/Table.svelte';
	import { JOURNAL_COLUMNS } from '$lib/components/columns';
	import { flights } from '$lib/flights.svelte';
</script>

<section class="w-full">
	<Table data={flights} columns={JOURNAL_COLUMNS} title="Журнал полётов" defaultSort="date" />
</section>
