/**
 * Загружает прежние демонстрационные данные как обычные записи через API.
 * Запуск: ACCESS_TOKEN=<токен из ссылки> node scripts/seed-demo.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';

const base = process.env.API_BASE_URL ?? 'http://localhost:8080';
const token = process.env.ACCESS_TOKEN;
if (!token) throw new Error('ACCESS_TOKEN is required');

function mock(file, key) {
	const source = fs.readFileSync(new URL(`../src/lib/mocs/${file}.ts`, import.meta.url), 'utf8');
	const output = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, { module, exports: module.exports });
	return module.exports[key];
}

function id(key) {
	const hex = crypto.createHash('sha256').update(`oi-bas-demo:${key}`).digest('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function api(path, options = {}) {
	const response = await fetch(`${base}/api/v1${path}`, {
		...options,
		headers: {
			authorization: `Bearer ${token}`,
			'content-type': 'application/json',
			...options.headers
		}
	});
	if (!response.ok)
		throw new Error(
			`${options.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`
		);
	return response.status === 204 ? null : response.json();
}

async function sync(entity, data) {
	return api('/sync', {
		method: 'POST',
		body: JSON.stringify({
			operations: [
				{ id: id(`seed-operation:${entity}:${data.id}`), entity, action: 'upsert', data }
			]
		})
	});
}

const fleet = mock('fleet', 'FLEET_MOCK');
const staff = mock('staff', 'STAFF_MOCK');
const flights = mock('flights', 'FLIGHTS_MOCK');
const checklists = mock('checklists', 'CHECKLISTS_MOCK');
const runs = mock('runs', 'RUNS_MOCK');
const sites = mock('sites', 'SITES_MOCK');
const batteries = mock('batteries', 'BATTERIES_MOCK');
const state = await api('/bootstrap');
const usersByName = new Map(state.users.map((user) => [user.name, user]));
const userIDs = new Map();

for (const person of staff) {
	if (person.id === 'u-001') {
		userIDs.set(person.id, state.profile.id);
		await api(`/users/${state.profile.id}`, {
			method: 'PUT',
			body: JSON.stringify({ ...state.profile, hours: person.hours, flights: person.flights })
		});
		continue;
	}
	let row = usersByName.get(person.name);
	if (!row) {
		const created = await api('/users', { method: 'POST', body: JSON.stringify(person) });
		row = created.user;
	}
	await api(`/users/${row.id}`, { method: 'PUT', body: JSON.stringify(person) });
	userIDs.set(person.id, row.id);
}

const aircraftIDs = new Map(fleet.map((aircraft) => [aircraft.id, id(aircraft.id)]));
const checklistIDs = new Map(checklists.map((list) => [list.id, id(list.id)]));
const flightIDs = new Map(flights.map((flight) => [flight.id, id(flight.id)]));
const runIDs = new Map(runs.map((run) => [run.id, id(run.id)]));
const batteryIDs = new Map(batteries.map((battery) => [battery.id, id(battery.id)]));
const itemIDs = new Map(
	checklists.flatMap((list) => list.items.map((item) => [item.id, id(item.id)]))
);

for (const aircraft of fleet)
	await sync('aircraft', { ...aircraft, id: aircraftIDs.get(aircraft.id) });
for (const list of checklists) {
	await sync('checklist', {
		...list,
		id: checklistIDs.get(list.id),
		aircraftId: list.aircraftId ? aircraftIDs.get(list.aircraftId) : '',
		items: list.items.map((item) => ({ ...item, id: itemIDs.get(item.id) }))
	});
}
for (const flight of flights) {
	const aircraft = fleet.find((item) => item.id === flight.aircraftId);
	const person = staff.find((item) => item.id === flight.pilotId);
	await sync('flight', {
		...flight,
		id: flightIDs.get(flight.id),
		aircraftId: aircraftIDs.get(flight.aircraftId),
		pilotId: userIDs.get(flight.pilotId),
		aircraft: aircraft?.model ?? '',
		pilot: person?.id === 'u-001' ? state.profile.name : (person?.name ?? ''),
		runId: flight.runId ? runIDs.get(flight.runId) : ''
	});
}
for (const run of runs) {
	await sync('run', {
		...run,
		id: runIDs.get(run.id),
		flightId: flightIDs.get(run.flightId),
		checklistId: checklistIDs.get(run.checklistId),
		answers: run.answers.map((answer) => ({ ...answer, itemId: itemIDs.get(answer.itemId) }))
	});
}
for (const site of sites) await sync('site', { ...site, id: id(site.id) });
for (const battery of batteries)
	await sync('battery', { ...battery, id: batteryIDs.get(battery.id) });

console.log(
	`Loaded ${staff.length} staff, ${fleet.length} aircraft, ${batteries.length} batteries, ${checklists.length} checklists, ${flights.length} flights, ${runs.length} runs and ${sites.length} sites.`
);
