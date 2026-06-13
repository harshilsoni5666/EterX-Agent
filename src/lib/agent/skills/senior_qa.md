---
name: "senior-qa"
description: Use for writing unit, integration, and E2E tests; improving coverage; setting up Playwright/Jest/Vitest/React Testing Library; reducing flaky tests; and defining release-quality verification plans.
---

# Senior QA Engineer

Use this skill to design practical tests that catch regressions without making the suite brittle.

## Testing Strategy

1. Start from risk: money movement, auth, data loss, permissions, critical user journeys, and recently changed code.
2. Prefer user-observable behavior over implementation details.
3. Put logic-heavy pure functions under unit tests.
4. Put module boundaries and data flow under integration tests.
5. Put critical journeys under E2E tests.
6. Avoid snapshots unless the rendered output is intentionally stable and meaningful.

## Useful Local Commands

Use what exists in `package.json` or the repository:

```bash
npm test
npm test -- --coverage
npm run test:unit
npm run test:e2e
npx playwright test
npx playwright test --debug
npx playwright show-report
```

If the project uses `pnpm`, `yarn`, `vitest`, `pytest`, or another runner, use the repo's native command instead.

## React Testing Library Pattern

```typescript
import { render, screen, fireEvent } from '@testing-library/react';
import { Button } from '../src/components/Button';

describe('Button', () => {
  it('renders an accessible button label', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole('button', { name: /click me/i })).toBeInTheDocument();
  });

  it('calls onClick when clicked', () => {
    const handleClick = jest.fn();
    render(<Button onClick={handleClick}>Click</Button>);
    fireEvent.click(screen.getByRole('button', { name: /click/i }));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });
});
```

## Playwright Pattern

```typescript
import { test, expect } from '@playwright/test';

test('user can sign in', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill('user@example.test');
  await page.getByLabel(/password/i).fill('correct-password');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/dashboard/);
});
```

## Coverage Review

- Treat coverage as a signal, not the target.
- Investigate uncovered branches in critical modules first.
- Add regression tests for every fixed bug when practical.
- Do not write tests that only assert mocks were called unless the collaboration itself is the behavior.
- Remove or quarantine flaky tests only with a tracking issue and owner.

## Flake Checklist

- Replace sleeps with event, URL, network, or DOM assertions.
- Use deterministic test data and isolated accounts.
- Reset database/browser state between tests.
- Avoid test order dependencies.
- Capture trace, screenshot, and logs for E2E failures.

## QA Output

For QA work, return:

- Test plan by layer.
- Exact files/tests added or changed.
- Commands run and results.
- Known gaps and why they remain.
- Release risk if tests cannot be run.
