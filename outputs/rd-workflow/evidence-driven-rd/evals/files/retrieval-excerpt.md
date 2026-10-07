# Historical excerpt for evaluation

This is a condensed excerpt of the user-supplied history, with physical JSONL locations; it is not a new experiment. Use only the facts below. Missing implementation/data are unavailable in this evaluation.

L248: The user specifies first 80% as training data, next 20% as test, and counts success only for a complete 256-bit match, compared against controls.

L328: Agent reports zero exact matches out of 193,978 and then discusses an improved mean Hamming distance.

L518: Full-corpus nearest search reports 193,978 exact matches out of 193,978. The query `previous_hash` equals the `own_hash` of a record already in that corpus.

L534: A later experiment excludes the direct matching record while retaining the full corpus.

L547: That no-self experiment reports zero exact matches; mean nearest distance is 58.26, versus random single-pick mean 94.72.

L577: 22.3% of nearest neighbors come from records positioned later than the query's height.
