import { useRef } from "react";

/**
 * A number that changes only when `value` really changes, for an effect that must run on the
 * *contents* of an object rather than on its identity.
 *
 * The obvious `JSON.stringify(value)` as a dependency serialises on **every render**, and during a
 * colour-wheel drag both the lighting panel and the LED preview render every frame over key arrays
 * that can hold a hundred ids. This serialises only when the reference has moved, and the store
 * gives a new reference only on a real edit.
 */
export function useStructuralKey(value: unknown): number {
  const last = useRef<{ value: unknown; json: string; key: number }>({ value: Symbol("none"), json: "", key: 0 });
  if (value !== last.current.value) {
    const json = JSON.stringify(value) ?? "";
    last.current = { value, json, key: json === last.current.json ? last.current.key : last.current.key + 1 };
  }
  return last.current.key;
}
