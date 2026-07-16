/**
 * Show translated labels in a select while returning the raw domain value.
 *
 * Product copy is Simplified Chinese but domain values stay English
 * (ADR 0011: selection values never couple to display labels). Every
 * TUI select over domain values must go through this helper; comparing
 * a select result against a raw value directly is the bug this exists
 * to prevent.
 */
export async function selectDomainValue<T extends string>(
  select: (title: string, options: string[]) => Promise<string | undefined>,
  title: string,
  values: readonly T[],
  label: (value: T) => string,
): Promise<T | undefined> {
  const choice = await select(
    title,
    values.map((value) => label(value)),
  );
  if (choice === undefined) return undefined;
  return values.find((value) => label(value) === choice);
}
