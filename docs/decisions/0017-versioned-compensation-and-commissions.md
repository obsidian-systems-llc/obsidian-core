# ADR-0017: Version compensation plans and preserve commission attribution

Hourly and salary compensation plans are effective-dated. Commission entries snapshot eligible
revenue, plan rate, attribution, and amount using integer minor units and basis points. The default
configuration is `$20.00/hour` and `10%`, but neither is a global hard-coded payroll rule.
