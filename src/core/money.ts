/**
 * Exact decimal arithmetic for money.
 *
 * Model rates are quoted as decimals with very few significant digits
 * (e.g. `0.02` CNY / 1M tokens) and token counts are large integers, so a
 * binary floating-point product accumulates avoidable error. Amounts are
 * therefore `bigint` scaled by 1e9, and `Number` appears only where a value is
 * rendered for display.
 */

/** Fixed-point scale: one unit is 1e-9 of the currency unit. */
import { UserError } from '../i18n/errors.ts';

export const MONEY_SCALE_DIGITS = 9;

const SCALE_FACTOR = 10n ** BigInt(MONEY_SCALE_DIGITS);

const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * Parse a decimal string into a scaled `bigint`.
 * @param text - decimal literal such as `"0.02"`, `"13.5"`, or `"-1"`.
 * @returns the value scaled by 1e9.
 * @throws when `text` is not a plain decimal literal or has more than 9 fractional digits.
 */
export function parseDecimal(text: string): bigint {
  const trimmed = text.trim();
  if (!DECIMAL_PATTERN.test(trimmed)) {
    throw new UserError('moneyNotDecimal', { value: JSON.stringify(text) });
  }
  const negative = trimmed.startsWith('-');
  const unsigned = trimmed.replace(/^[+-]/, '');
  const [whole = '0', fraction = ''] = unsigned.split('.');
  if (fraction.length > MONEY_SCALE_DIGITS) {
    throw new UserError('moneyTooManyDigits', { value: JSON.stringify(text) });
  }
  const value = BigInt(`${whole}${fraction.padEnd(MONEY_SCALE_DIGITS, '0')}`);
  return negative ? -value : value;
}

/**
 * Scale an integer token count by an amount charged per 1,000,000 tokens.
 * @param tokens - token count; must be a non-negative safe integer.
 * @param amount - the amount charged per 1,000,000 tokens, in scaled units.
 * @returns `tokens * amount / 1_000_000`, exactly.
 * @throws when `tokens` is not a non-negative safe integer.
 */
export function scalePerMillion(tokens: number, amount: bigint): bigint {
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    throw new UserError('moneyTokenNotInteger', { value: String(tokens) });
  }
  if (tokens === 0 || amount === 0n) return 0n;
  return (BigInt(tokens) * amount) / 1_000_000n;
}

/**
 * Render a scaled amount as a decimal string, rounded half-up to `digits` places.
 * @param value - scaled amount.
 * @param digits - fractional digits to keep (0-9).
 * @returns the decimal string, without an exponent.
 * @throws when `digits` is outside 0-9.
 */
export function formatDecimal(value: bigint, digits: number): string {
  if (!Number.isInteger(digits) || digits < 0 || digits > MONEY_SCALE_DIGITS) {
    throw new UserError('moneyDigitsRange', { value: String(digits) });
  }
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const divisor = 10n ** BigInt(MONEY_SCALE_DIGITS - digits);
  const rounded = (magnitude + divisor / 2n) / divisor;
  const text = rounded.toString().padStart(digits + 1, '0');
  const whole = digits === 0 ? text : text.slice(0, text.length - digits);
  const fraction = digits === 0 ? '' : text.slice(text.length - digits);
  const body = fraction.length > 0 ? `${whole}.${fraction}` : whole;
  return negative && rounded !== 0n ? `-${body}` : body;
}

/**
 * Convert a scaled amount to a `Number` for JSON interchange.
 * @param value - scaled amount.
 * @param digits - fractional digits to round to before converting.
 * @returns the rounded value.
 */
export function toNumber(value: bigint, digits: number): number {
  return Number(formatDecimal(value, digits));
}

/** Sum a list of scaled amounts. */
export function sumAmounts(values: readonly bigint[]): bigint {
  let total = 0n;
  for (const value of values) total += value;
  return total;
}

/** The scale factor as a bigint, for callers that scale values themselves. */
export const MONEY_SCALE: bigint = SCALE_FACTOR;

/**
 * Multiply two decimal strings, keeping 9 fractional digits.
 * @param left - first factor.
 * @param right - second factor.
 * @returns the product, truncated at the arithmetic scale.
 */
export function multiplyDecimal(left: string, right: string): string {
  return formatDecimal((parseDecimal(left) * parseDecimal(right)) / SCALE_FACTOR, MONEY_SCALE_DIGITS);
}

/**
 * Divide two decimal strings, keeping 9 fractional digits.
 * @param left - dividend.
 * @param right - divisor.
 * @returns the quotient, truncated at the arithmetic scale.
 * @throws when the divisor is zero.
 */
export function divideDecimal(left: string, right: string): string {
  const divisor = parseDecimal(right);
  if (divisor === 0n) throw new UserError('moneyDivideByZero', {});
  return formatDecimal((parseDecimal(left) * SCALE_FACTOR) / divisor, MONEY_SCALE_DIGITS);
}

/**
 * Drop trailing fractional zeros.
 *
 * Used for rates rather than amounts: `5.000000000` is the same rate as `5`, and
 * carrying the zeros would suggest a precision the number does not have.
 * @param text - a decimal string.
 * @returns the same value without trailing zeros.
 */
export function trimDecimal(text: string): string {
  const [whole = '0', fraction = ''] = text.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed.length === 0 ? whole : `${whole}.${trimmed}`;
}
