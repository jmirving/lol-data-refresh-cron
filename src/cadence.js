function policy(name, evaluate) {
  return Object.freeze({ name, evaluate });
}

export function everyInvocation() {
  return policy("every-invocation", () => ({ eligible: true }));
}

// Daily eligibility deliberately has no persistence semantics. The outer
// scheduler controls invocation frequency; this policy permits each invocation.
export function daily() {
  return policy("daily", () => ({ eligible: true }));
}

export function selectedWeekdays(weekdays) {
  const selected = new Set(weekdays);
  for (const weekday of selected) {
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw new TypeError("weekdays must contain UTC day numbers from 0 through 6");
    }
  }

  return policy(`weekdays:${[...selected].sort().join(",")}`, ({ scheduledAt }) => {
    const eligible = selected.has(scheduledAt.getUTCDay());
    return {
      eligible,
      reason: eligible ? undefined : "scheduled weekday is not selected",
    };
  });
}

export function selectedMonthDays(days) {
  const selected = new Set(days);
  for (const day of selected) {
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      throw new TypeError("month days must contain integers from 1 through 31");
    }
  }

  return policy(`month-days:${[...selected].sort((a, b) => a - b).join(",")}`, ({ scheduledAt }) => {
    const eligible = selected.has(scheduledAt.getUTCDate());
    return {
      eligible,
      reason: eligible ? undefined : "scheduled month day is not selected",
    };
  });
}

export function eligibilityPolicy(name, evaluate) {
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("eligibility policy name must be a non-empty string");
  }
  if (typeof evaluate !== "function") {
    throw new TypeError("eligibility policy evaluate must be a function");
  }
  return policy(name, evaluate);
}
