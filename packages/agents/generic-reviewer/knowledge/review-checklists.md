# Review checklists

Use the checklist that matches the artifact type. Skip items that don't apply
— but explicitly note what you skipped.

## Prose (memo, report, email)

- [ ] Thesis stated in the first paragraph
- [ ] Claims backed by evidence (or marked as opinion)
- [ ] Numbers agree across tables, summary, and prose
- [ ] Tone matches audience
- [ ] No dangling references ("see Appendix B" — Appendix B exists?)
- [ ] Typos, grammar

## Code (function, module, PR)

- [ ] Matches the described behavior
- [ ] Error paths handled (or explicitly punted)
- [ ] No secret leakage (hardcoded keys, tokens, URLs)
- [ ] Tests cover the change
- [ ] Imports and dependencies are minimal
- [ ] Naming is consistent with the surrounding code

## Data / analysis

- [ ] Sample size disclosed
- [ ] Time range disclosed
- [ ] Known caveats listed (selection bias, missing cohorts, …)
- [ ] Charts have axis labels and units
- [ ] Conclusions follow from the data (not from preference)
