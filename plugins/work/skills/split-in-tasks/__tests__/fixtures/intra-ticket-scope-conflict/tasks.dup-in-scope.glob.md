# Tasks (intra-ticket joint in-scope ownership fixture — dup-in-scope glob+literal)

_Invalid fixture: Task 1 owns `lib/foo/**` (glob) and Task 2 owns `lib/foo/bar.ts` (literal) under `### Files in scope`. The glob covers the literal — the intra-ticket validator must flag exactly one joint-ownership conflict._

## Task 1 — Own lib/foo glob

### Type
wiring

### Files in scope
- `lib/foo/**`

### Deliverables
- [ ] 1.1 **GREEN:** populate lib/foo
  - Test: lib/foo modules export expected symbols

### Test Command
```bash
CHANGED_FILES="lib/foo/index.test.ts" eval "$TEST_UNIT_COMMAND"
```

---

## Task 2 — Own lib/foo/bar.ts

### Type
wiring

### Files in scope
- `lib/foo/bar.ts`

### Deliverables
- [ ] 2.1 **GREEN:** implement bar
  - Test: `bar()` returns expected value

### Test Command
```bash
CHANGED_FILES="lib/foo/bar.test.ts" eval "$TEST_UNIT_COMMAND"
```
