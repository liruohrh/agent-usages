/**
 * The holiday calendar's shape.
 *
 * The dates are data: `config/holidays.json` ships them and `config/holidays.ts`
 * reads, parses and caches them. The engine that asks the calendar "is this day a
 * holiday?" lives in `pricing/`. Both layers have to name this shape, so it
 * belongs to neither of them — it sits in the neutral core, which is what keeps
 * the dependency between the two layers one-way (`config → pricing`).
 */

/** A calendar id a period may name. Only China is shipped today. */
export type CalendarId = 'cn';

/**
 * Every calendar this build knows.
 *
 * The *dates* are data (`config/holidays.json`); which calendars exist is a
 * contract, and a price list that names an unknown one is a configuration error
 * rather than a silent fallback.
 */
export const CALENDAR_IDS: readonly CalendarId[] = ['cn'];

/** The parsed calendar, ready to answer "is this date a holiday?". */
export interface HolidayCalendar {
  /** Which calendar this is. */
  id: CalendarId;
  /** The clock its dates are written in, e.g. `Asia/Shanghai`. */
  zone: string;
  /** `YYYY-MM-DD` → the holiday's name. */
  days: ReadonlyMap<string, string>;
  /** First and last date the calendar covers, both inclusive. */
  from: string;
  to: string;
  /** Where the dates came from, for the report's provenance line. */
  source: string;
}
