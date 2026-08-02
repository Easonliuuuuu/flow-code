export declare function confirm(question: string, opts?: {
    defaultAnswer?: boolean;
}): Promise<boolean>;
/** Plain, unmasked free-text prompt — used for things like a typed-in model id. */
export declare function promptText(question: string): Promise<string>;
/** Reads one line from stdin without echoing it, masking each keystroke with `*`. Caller must check isTTY first. */
export declare function promptSecret(question: string): Promise<string>;
