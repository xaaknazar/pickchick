# App sounds

- `paid.wav`: the soft two-note chime of a successful payment (C6 then G6, sine with a quiet
  overtone, 6 ms attack, ~0.6 s decay, peak −6 dBFS). Synthesized for PickChick on 25.11.2026 by a
  short Python script (no samples, no third-party audio). It plays only when the phone's ring/silent
  switch is on ring, mixes with music and never ducks it (`src/feedback.ts`).
