import { Input } from "@earendil-works/pi-tui";

export class SecretInput extends Input {
  render(width: number) {
    const value = this.getValue();
    // Input.setValue preserves the cursor. Use equal-length masking without changing editing/undo behavior.
    this.setValue("*".repeat(value.length));
    try {
      return super.render(width);
    } finally {
      this.setValue(value);
    }
  }
}
