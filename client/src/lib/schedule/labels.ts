/**
 * Civil-day labels, spelled out by hand.
 *
 * `Intl` month abbreviations change between ICU releases ("Sep" / "Sept"), and
 * a date that is already a gym day must not have a zone applied to it. So the
 * names are a table and the date is read at UTC.
 */
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const utc = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

export const shortWeekday = (day: string): string => WEEKDAY_SHORT[utc(day).getUTCDay()] as string;
export const longWeekday = (day: string): string => WEEKDAY_LONG[utc(day).getUTCDay()] as string;
export const dayNumber = (day: string): string => String(utc(day).getUTCDate());
/** '26 Nov' — a day and its month, no weekday. */
export const dayMonth = (day: string): string =>
  `${dayNumber(day)} ${MONTH_SHORT[utc(day).getUTCMonth()]}`;
export const shortDay = (day: string): string =>
  `${shortWeekday(day)} ${dayNumber(day)} ${MONTH_SHORT[utc(day).getUTCMonth()]}`;
export const longDay = (day: string): string =>
  `${WEEKDAY_LONG[utc(day).getUTCDay()]} ${dayNumber(day)} ${MONTH_LONG[utc(day).getUTCMonth()]}`;
export const monthTitle = (day: string): string =>
  `${MONTH_LONG[utc(day).getUTCMonth()]} ${utc(day).getUTCFullYear()}`;
