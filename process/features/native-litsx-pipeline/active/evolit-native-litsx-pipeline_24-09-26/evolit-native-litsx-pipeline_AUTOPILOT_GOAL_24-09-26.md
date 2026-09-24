# Evolit Native LitSX Pipeline — Autopilot Goal

Emitted: 2026-09-24T00:00:00+02:00. This is the provisional block. V7 of VALIDATE will emit the (UPDATE) variant.

```text
SESSION GOAL: Implementar y publicar una configuración nativa, tipada y genérica del pipeline LitSX en Evolit, con integración directa de @litsx/unocss y cobertura dev/SSR/hidratación/build/standalone.
ENTRY PHASE: RESEARCH (sin fases previas completadas)
REMAINING PHASES:
  [ ] RESEARCH — equipo coordinado para contratos Evolit/LitSX/UnoCSS
  [ ] SPEC — síntesis secuencial de requisitos verificables
  [ ] INNOVATE — equipo coordinado para alternativas y selección
  [ ] PLAN — equipo coordinado para programa multifase y blast radius
  [ ] VALIDATE — revisiones paralelas independientes y contrato de gates
  [ ] EXECUTE — implementación centralizada con revisión y pruebas coordinadas
  [ ] UPDATE PROCESS — cierre, contexto durable y evidencia de publicación
CLARIFICATIONS LOCKED:
  1. Puede modificarse y publicarse @litsx/unocss si su API neutral actual no basta.
  2. Terminado exige versiones publicadas y consumidor limpio sin parches ni adaptadores.
  3. Se preservan las restricciones, regresiones y matriz de pruebas solicitadas.
  4. Estrategia aprobada: equipo coordinado pequeño, máximo 9 intervenciones previstas.
EXECUTE CONSENT: standing-granted via autopilot trigger (2026-09-24)
DECISION POLICY: Autodecidir cambios reversibles dentro del alcance; priorizar protocolo genérico factory-based, compatibilidad y aislamiento; publicación final de Evolit y @litsx/unocss expresamente autorizada tras gates verdes.
HARD STOPS:
  - Acciones externas distintas de las publicaciones autorizadas
  - Cascade BLOCKED (2 fases consecutivas bloqueadas)
  - Probe con proveedor real o coste
TEST GATES: TBD — populated after VALIDATE
START: Completar RESEARCH y formalizar SPEC/arquitectura coordinada.
LANE: full
```

## (UPDATE) 2026-09-24

```text
SESSION GOAL: (UPDATE) Implementar y publicar configuración nativa, tipada y genérica del pipeline LitSX en Evolit con integración directa de @litsx/unocss.
ENTRY PHASE: EXECUTE (RESEARCH, SPEC, INNOVATE, PLAN y Phase 1 VALIDATE completos)
REMAINING PHASES:
  [ ] EXECUTE/EVL/UPDATE Phase 1 — pipeline genérico Evolit
  [ ] Phase 2 — integración neutral @litsx/unocss
  [ ] Phase 3 — fixture Shadow DOM y matriz runtime
  [ ] Phase 4 — release y consumidor limpio
CLARIFICATIONS LOCKED: cambios y publicación coordinados autorizados; sin adaptadores, branches UnoCSS, react-compat ni pipeline Vite/PostCSS propio.
EXECUTE CONSENT: standing-granted via autopilot trigger (2026-09-24)
DECISION POLICY: Autodecidir cambios reversibles; factories aisladas por runtime; invariantes Evolit prevalecen; publicación solo con candidato exacto verde.
HARD STOPS:
  - Acción externa distinta de publicaciones autorizadas
  - Cascade BLOCKED
  - Probe con proveedor real o coste
TEST GATES: focused pipeline/type suites; compiler/assets/runtime/setup regressions; yarn workspace evolit typecheck; yarn workspace evolit test; yarn build; yarn test:browser; release:check; release:preflight; clean consumer.
START: Phase 1 EXECUTE con validate-contract CONDITIONAL y 0 FAIL.
LANE: full
```
