# Product

## Register

product

## Platform

terminal

## Users

Primary users are Pi users coordinating Herdr coding Agents from inside one local Herdr workspace, including users who need to create one new Agent as part of an explicit dispatch flow. They are usually developers or agent operators working in a terminal/TUI flow who need to hand off bounded work without losing control of scope, safety reservations, or result delivery.

Secondary readers include package maintainers reviewing whether the implementation preserves the confirmed-dispatch contract. Target Agents are participants in the protocol, but the human-facing UI is designed for the Origin user who confirms, monitors, replies, cancels, or resolves a dispatch.

## Product Purpose

`pi-herdr-dispatch` is a terminal/TUI plugin for Pi Agent. It lets a Pi session create or select an Agent, deliver, monitor, and settle work through one typed path. Its bundled `hd-crew` Skill routes explicit natural-language delegation through the same typed model tools while keeping Agent creation, reply, cancellation, resolution, seen-state cleanup, and integration setup as user TUI actions. It exists to make multi-Agent coordination explicit and recoverable: Agent creation is user-initiated and visible, never model-autonomous; there is no raw Herdr tasking bypass, no automatic resend after ambiguity, and no untrusted output entering model context without explicit framing.

Success means a user can confidently answer: what is being sent, to which Agent, in which directory/worktree, under which mutation mode, with which deadline, and what happened afterward. When delivery, monitoring, or target identity becomes uncertain, the UI should surface that uncertainty plainly and keep reservations intact until an explicit human resolution.

## Positioning

User-directed Agent launch and typed dispatch, not autonomous delegation.

## Brand Personality

Careful, explicit, calm. The UI should feel like a precise operations instrument: terse enough for expert terminal users, but never coy about safety boundaries, residual risk, or required human decisions.

## Anti-references

Do not feel like an autonomous black box. The package should never imply that it secretly acts, infers, resends, retargets, launches Agents without an explicit `/hd-create`, takes over monitoring, or converts ambiguous evidence into certainty without the user.

## Design Principles

1. Show the contract before acting. Proposal, reply, cancellation, and resolution surfaces should make the exact action and consequences visible before any state changes.
2. Prefer explicit uncertainty over comforting fiction. Ambiguous delivery, stale identity, missing results, and advisory safety limits should be named directly.
3. Keep coordination state compact but legible. Status tables, widgets, and result cards should privilege lifecycle, attention, target, mode, and deadline over decoration.
4. Preserve trust boundaries in the interface. Untrusted Agent metadata/output/results must remain visibly framed as data, not instructions.
5. Recovery is part of the product. Manual and emergency resolution flows should be calm, procedural, and hard to mistake for routine success.

## Accessibility & Inclusion

Target WCAG 2.2 AA where applicable to terminal/TUI surfaces. Do not rely on color alone for state: pair semantic colors with labels, glyphs, and clear text. Keep tables aligned and scannable in narrow terminals, preserve keyboard-first interaction, maintain readable contrast through Pi theme colors, and provide reduced-motion-safe behavior if motion is ever introduced.
