If ARTIFACT_PATH exists, Read it and Write it back with every earlier round unchanged, then append
`## Round {{ROUND}}` at the end with this launch's whole output (every mandatory section, the verdict
line included). Never edit an earlier round; otherwise create it with `## Round {{ROUND}}`.
