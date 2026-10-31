import type { SyntheticEvent } from "react";

type FormEvent = Event | SyntheticEvent;

/** Native and React form events keep DOM casts out of component markup. */
export const inputValue = (event: FormEvent) =>
  (event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
export const inputChecked = (event: FormEvent) => (event.target as HTMLInputElement).checked;
