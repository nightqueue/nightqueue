// Erro previsto de uso da CLI: unico sinal que vira exit code 1.
export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = "UserError";
  }
}
