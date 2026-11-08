const REF = /\br\d+\b/g;
const NUMBER = /\d+/g;
const SHELTER = /\bshelter-[a-z0-9]+\b/g;
export const FALLBACK_SENTENCE = 'Model unavailable; deterministic plan only.';

export interface GroundEvent {
  toolName: string;
  resultRef: string;
  resultSummary: string;
  live: boolean;
}

export function reviewModelResult(input: {
  outcome: string;
  explanation: string;
  live: boolean;
  shelterId: string;
  events: readonly GroundEvent[];
  extraShelters: readonly string[];
}): { outcome: string; explanation: string; live: boolean; rejectReason: string } {
  const fallback = input.explanation.includes(FALLBACK_SENTENCE);
  if (input.outcome === 'fallback' || input.outcome === 'timeout' || input.outcome === 'failed') {
    if ((input.outcome === 'fallback' || input.outcome === 'timeout') && !fallback) {
      return { outcome: 'rejected', explanation: input.explanation, live: false, rejectReason: 'MISSING_FALLBACK' };
    }
    return { outcome: input.outcome, explanation: input.explanation, live: false, rejectReason: '' };
  }
  if (input.outcome !== 'proposal' && input.outcome !== 'rejected') {
    return { outcome: 'rejected', explanation: input.explanation, live: false, rejectReason: 'INVALID_OUTCOME' };
  }
  const refs = Array.from(input.explanation.match(REF) ?? []);
  const known = new Set(input.events.map(event => event.resultRef));
  if (refs.length === 0 || refs.some(ref => !known.has(ref))) {
    return { outcome: 'rejected', explanation: input.explanation, live: false, rejectReason: 'NO_CITATION' };
  }
  const cited = input.events.filter(event => refs.includes(event.resultRef));
  const allowedNumbers = new Set(cited.flatMap(event => Array.from(event.resultSummary.match(NUMBER) ?? [])));
  const invented = Array.from(input.explanation.replace(REF, ' ').match(NUMBER) ?? []).some(value => !allowedNumbers.has(value));
  if (invented) {
    return { outcome: 'rejected', explanation: input.explanation, live: false, rejectReason: 'INVENTED_NUMBER' };
  }
  const shelters = new Set([input.shelterId, ...input.extraShelters]);
  const mentioned = Array.from(input.explanation.match(SHELTER) ?? []);
  if (mentioned.some(id => !shelters.has(id))) {
    return { outcome: 'rejected', explanation: input.explanation, live: false, rejectReason: 'DESTINATION' };
  }
  if (cited.some(event => event.toolName === 'run_what_if') && !input.explanation.toLowerCase().includes('hypothetical')) {
    return { outcome: 'rejected', explanation: input.explanation, live: false, rejectReason: 'HYPOTHETICAL' };
  }
  const live = input.live && cited.every(event => event.live) && !fallback;
  return { outcome: input.outcome, explanation: input.explanation, live, rejectReason: '' };
}
