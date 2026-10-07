# Historical excerpt for evaluation

The following are recorded values and visible code from the supplied history, not freshly measured outputs. The actual dataset and complete implementation are not provided for this evaluation.

L1587: 889,703 of 969,887 historical valid pairs lie in distance [68.8,109.0]: 91.733%.

L2490: Candidate filter uses 1,000 candidates and ten sampled trials per candidate, checking distance [69,109]. Mean accepted fraction is 9.92%.

L2578: The user supplies partial run output for a later filter: 99.64% rejected at scale 1,000 and 99.63% rejected at scale 10,000; savings are reported as 97.0% and 99.4%.

L2596 contains this code:

```python
# Pre-filter nonce samples
nonce_samples = rng.integers(0, 0xFFFFFFFF, 100, dtype=np.uint32)
# Rejection threshold: < 5% of samples in corridor
if n_in < 5:
    rejected += 1
else:
    admissible += 1
# Simulated full header cost
t_full_simulated = t_prefilter * 10
t_full_total += t_full_simulated * admissible
```

L2674: The assistant treats historical coverage 91.73% as probability of arbitrary candidate-output passage and concludes 9.92% acceptance must be a code bug.
