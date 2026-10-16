// Types for the pure helpers run-selftests.mjs exports (its selftest imports them; the runner itself stays plain .mjs).
export function killsByPattern(text: string): boolean;
export function fixtureLint(text: string, liveSids: string[]): string[];
export function shellWords(text: string): string[];
export function jsStringLiterals(src: string): string[];
