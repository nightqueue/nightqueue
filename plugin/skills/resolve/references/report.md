## 🗂️ Report — {{SLUG}}

{{#FAST_TRACK}}
Verification {{VERIFICATION_ICON}} · {{DELIVERY}}
{{/FAST_TRACK}}
{{^FAST_TRACK}}
| Step | Agent | Status | Highlight |
|-------|--------|--------|----------|
{{STEP_ROWS}}
{{/FAST_TRACK}}

{{LESSONS_LINE}}
{{HAPPY_LINE}}
{{^HAPPY}}

| Step | Agent | Status | Summary | Time |
|-------|--------|--------|--------|-------|
{{EXECUTION_ROWS}}

**Total:** ⏱️ {{TOTAL}}
{{/HAPPY}}
