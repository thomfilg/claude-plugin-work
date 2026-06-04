# Tasks (intra-ticket joint in-scope ownership fixture — dup-in-scope literal)

_Invalid fixture: Task 1 and Task 2 both list the literal `components/X.tsx` under `### Files in scope`. The intra-ticket validator must flag this joint-ownership conflict._

## Task 1 — Wire components/X.tsx variant A

### Type
wiring

### Files in scope
- `components/X.tsx`

### Deliverables
- [ ] 1.1 **GREEN:** render X variant A
  - Test: `<X variant="a" />` renders

### Test Command
```bash
CHANGED_FILES="components/X.test.tsx" eval "$TEST_UNIT_COMMAND"
```

---

## Task 2 — Wire components/X.tsx variant B

### Type
wiring

### Files in scope
- `components/X.tsx`

### Deliverables
- [ ] 2.1 **GREEN:** render X variant B
  - Test: `<X variant="b" />` renders

### Test Command
```bash
CHANGED_FILES="components/X.test.tsx" eval "$TEST_UNIT_COMMAND"
```
