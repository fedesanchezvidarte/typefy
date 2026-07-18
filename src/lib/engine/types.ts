export type CharacterState = 'pending' | 'correct' | 'corrected' | 'incorrect';

/** One entry in the keystroke log — the single source of truth for all metrics. */
export interface Keystroke {
	kind: 'char' | 'backspace';
	char?: string; // the composed character as delivered by beforeinput/input (e.g. 'á', never a dead key)
	expected?: string; // expected character at the position (kind 'char' only)
	position: number; // cursor position the event applied to
	judgment?: 'hit' | 'miss'; // kind 'char' only
	firstAttempt: boolean; // true iff this stroke created the position's first-attempt record
	timestamp: number; // ms — injected by the caller (fake-clock friendly)
}

export type ChunkEvent =
	| { type: 'char'; char: string; timestamp: number }
	| { type: 'backspace'; timestamp: number }
	| { type: 'restart' };

export interface ChunkEngineState {
	readonly text: string;
	readonly cursor: number;
	readonly display: readonly CharacterState[]; // what the UI renders
	readonly firstAttempts: readonly ('hit' | 'miss' | null)[]; // immutable once set; drives Accuracy (raw)
	readonly log: readonly Keystroke[];
	readonly startedAt: number | null; // timestamp of first keystroke
	readonly completedAt: number | null; // set the instant no char is pending/incorrect
	readonly completed: boolean;
}
