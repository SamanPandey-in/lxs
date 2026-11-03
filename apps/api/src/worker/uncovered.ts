import type { DecoyEvent } from '@lxs/schema';
import type { EventTag } from '@lxs/detection';
import { sha256hex } from '../lib/crypto.js';

export interface TaggedEvent { event: DecoyEvent; tag: EventTag }

export function computeUncovered(events: TaggedEvent[], matchedEventIds: string[] = []): DecoyEvent[] {
  const matched = new Set(matchedEventIds);
  return events.filter(({ event, tag }) => {
    if (matched.has(event.id)) return false;
    // The established tagger adds generic R07/T1059 tags to each shell command,
    // while R07 only enters the authoritative ledger after three commands.
    // Ignore those two generic tags unless a real detection cites the event.
    const hints = tag.ruleHints.filter((id) => !(event.event_type === 'command.exec' && id === 'R07'));
    const techniques = tag.techniques.filter((t) => !(event.event_type === 'command.exec' && t.id === 'T1059.004'));
    return hints.length === 0 && techniques.length === 0;
  }).map(({ event }) => event);
}

export function needsAssessment(input: {
  aiEnabled: boolean;
  label: string;
  uncovered: DecoyEvent[];
  events: DecoyEvent[];
}): boolean {
  if (!input.aiEnabled || input.label === 'noise') return false;
  const material = input.uncovered.filter((e) => e.event_type === 'command.exec').length >= 1 ||
    input.uncovered.filter((e) => e.event_type === 'http.request').length >= 3;
  const interactive = input.events.some((e) => e.event_type === 'auth.attempt' && e.outcome === 'success');
  return material && interactive;
}

export function uncoveredFingerprint(events: DecoyEvent[], label: string): string {
  const shapes = events.map((e) => {
    const command = typeof e.command === 'string' ? e.command.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 200) : '';
    const url = typeof e.url === 'string' ? e.url.split('?')[0]!.toLowerCase().slice(0, 200) : '';
    return `${e.event_type}|${e.outcome ?? 'unknown'}|${e.dst_service ?? ''}|${command}|${url}`;
  }).sort();
  return sha256hex(JSON.stringify({ label, shapes }));
}
