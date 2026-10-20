/** Native form events keep DOM casts out of component templates. */
export const inputValue = (event: Event) =>
  (event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)
    .value;
export const inputChecked = (event: Event) =>
  (event.target as HTMLInputElement).checked;
