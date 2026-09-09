/** Точка на карте: координаты площадки, снятые на месте */
export type Spot = { lat: number; lon: number };

/**
 * Координаты с устройства (ФТ-6.8: подпись фиксирует координаты).
 *
 * Браузер отдаёт их только по разрешению пользователя и только на https
 * или на localhost — на телефоне, открытом по http в локальной сети,
 * запрос откажет, и параметры придётся заполнить руками.
 */
export function locate(timeoutMs = 8000): Promise<Spot> {
	return new Promise((resolve, reject) => {
		if (typeof navigator === 'undefined' || !navigator.geolocation) {
			reject(new Error('Устройство не отдаёт координаты'));
			return;
		}
		navigator.geolocation.getCurrentPosition(
			(pos) =>
				resolve({ lat: +pos.coords.latitude.toFixed(4), lon: +pos.coords.longitude.toFixed(4) }),
			(err) =>
				reject(
					new Error(
						err.code === err.PERMISSION_DENIED
							? 'Доступ к геолокации закрыт'
							: 'Не удалось определить координаты'
					)
				),
			{ enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60_000 }
		);
	});
}

/** Коды погоды Open-Meteo (WMO) словами */
const SKY: Record<number, string> = {
	0: 'ясно',
	1: 'преимущественно ясно',
	2: 'переменная облачность',
	3: 'пасмурно',
	45: 'туман',
	48: 'изморозь',
	51: 'слабая морось',
	53: 'морось',
	55: 'сильная морось',
	61: 'слабый дождь',
	63: 'дождь',
	65: 'сильный дождь',
	66: 'ледяной дождь',
	71: 'слабый снег',
	73: 'снег',
	75: 'сильный снег',
	77: 'снежная крупа',
	80: 'ливень',
	81: 'сильный ливень',
	82: 'очень сильный ливень',
	85: 'снегопад',
	95: 'гроза',
	96: 'гроза с градом'
};

/**
 * Погода на площадке по координатам.
 *
 * Open-Meteo выбран потому, что не требует ключа и отвечает с CORS —
 * запрос уходит прямо с устройства пилота. Связи нет — вызов упадёт,
 * и погоду вводят руками: параметр обязательный, источник — нет.
 */
export async function weatherAt({ lat, lon }: Spot): Promise<string> {
	const url =
		`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
		`&current=temperature_2m,wind_speed_10m,weather_code&wind_speed_unit=ms`;

	const res = await fetch(url);
	if (!res.ok) throw new Error('Метеослужба не ответила');

	const now = (await res.json())?.current;
	if (!now) throw new Error('Метеослужба вернула пустой ответ');

	const wind = Math.round(now.wind_speed_10m);
	const temp = Math.round(now.temperature_2m);
	const sky = SKY[now.weather_code] ?? 'без описания';
	return `Ветер ${wind} м/с, ${temp > 0 ? '+' : ''}${temp} °C, ${sky}`;
}
