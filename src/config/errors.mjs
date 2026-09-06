// Expected CLI usage error: the only signal that turns into exit code 1.
export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = "UserError";
  }
}
