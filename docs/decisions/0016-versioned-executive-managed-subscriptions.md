# ADR-0016: Version subscription plans under executive authorization

Subscription plans use immutable effective-dated versions and customer agreements retain their selected
version. The initial Device Protection configuration is `$15.00` monthly (`1500` USD minor units),
but it is a configuration default rather than a hard-coded billing rule. Only the Executive Panel
permission `subscription.plan.manage` may create future plan versions.
