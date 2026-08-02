/** Thrown (or used to reject a pending port) when a run is interrupted mid-flight. */
export class RunInterruptedError extends Error {
    constructor(message = 'run interrupted') {
        super(message);
    }
}
//# sourceMappingURL=types.js.map