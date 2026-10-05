const BRAND = Symbol.for('agent-work.refusal')

/** A refusal shown to the person acting as is, with its HTTP status. */
export class Refusal extends Error {
  readonly status: number
  readonly [BRAND] = true

  constructor(status: number, message: string) {
    super(message)
    this.name = 'Refusal'
    this.status = status
  }

  /**
   * A refusal from any copy of this module: the web console's bundler may load
   * the service's modules twice (once for the process, once for its routes).
   */
  static is(value: unknown): value is Refusal {
    return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[BRAND] === true
  }
}
