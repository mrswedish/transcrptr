# Lokal kopia av speakrs 0.7.0 (Apache-2.0)

Originalet: https://github.com/avencera/speakrs (crates.io: `speakrs` 0.7.0). Licens i `LICENSE`.

Ändringar mot originalet:

1. `src/inference/cpu/gemm.rs`: matrismultiplikationen på CPU (utanför macOS Accelerate) kör
   `gemm`-cratet i stället för ndarrays `general_mat_mul`. På macOS utan Accelerate gav det
   ca 1,45× högre hastighet (12,5× mot 8,7× realtid) med oförändrade talare.
2. `Cargo.toml`: beroendet `gemm = "0.19"` tillagt; binär- och exempelmål samt `include`
   borttagna (`src/bin`, `examples` ingår inte i kopian).

Allt annat är oförändrat. Vid uppgradering: hämta ny version, applicera punkt 1 igen.
