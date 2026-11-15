/**
 * Why a stage or check matters, and what failure looks like (RECORD.md §7.8 explanation
 * layer). Pure content: no filesystem, no Cordis. The panel and the exported package both use
 * these strings so the teaching text cannot drift from what ran.
 */

export const STAGE_EXPLAIN = {
  preflight: {
    why: 'Confirms the inputs, environment and parameter combinations before any expensive work starts.',
    failure: 'Missing files, unreadable NIfTI headers, or an invalid flag combination should stop here, not mid-pipeline.',
  },
  stage00: {
    why: 'Denoising (NORDIC/phase) improves SNR before motion and registration decisions are made.',
    failure: 'Excess noise reduction can blur task signal; check residual structure and the phase/NORDIC QC.',
  },
  stage01: {
    why: 'Slice-timing and MEDIC correct acquisition order and geometric distortion early.',
    failure: 'Wrong slice timing shifts event timing; residual dropout shows in the QC and registration views.',
  },
  stage02: {
    why: 'Motion correction aligns volumes to a reference so later fits do not model motion as brain signal.',
    failure: 'Large or sudden motion leaves ghosting; inspect FD and the motion QC before trusting the fit.',
  },
  stage03: {
    why: 'Locomoco compensates within-run motion by re-aligning the data to a static reference.',
    failure: 'Over-correction can remove task-locked signal; compare stimulated and uncorrected runs.',
  },
  stage04: {
    why: 'Fieldmap-based distortion correction reduces geometric warp in EPI data.',
    failure: 'Bad fieldmaps make the correction worse than none; verify blip/flip quality and the reference alignment.',
  },
  stage05: {
    why: 'Aligns functional data to the fieldmap so distortion correction applies in the right space.',
    failure: 'Misalignment shows as a displaced brain in the cross-fmap QC; check the alignment matrices.',
  },
  stage06: {
    why: 'Cross-run alignment puts every run in one space for a single model.',
    failure: 'A run that failed alignment will shift the mean and inflate residual variance in the GLM.',
  },
  stage07: {
    why: 'Builds run and session means: the reference images later alignment and visualization rely on.',
    failure: 'A smeared mean usually means failed motion/alignment in one run.',
  },
  stage08: {
    why: 'Aligns sessions to a grandmean space when data spans sessions.',
    failure: 'Wrong session alignment is visible as inter-session ghosting in the mean.',
  },
  stage08b: {
    why: 'Warps runs into the grandmean space so all runs can be composed consistently.',
    failure: 'Incorrect warps show as blur in the composed mean and reduced fit quality.',
  },
  stage09: {
    why: 'Aligns functional and anatomical data so results can be reported on the subject anatomy.',
    failure: 'A misregistration shows in the alignment QC; do not trust voxel-level anatomy claims until fixed.',
  },
  stage09b: {
    why: 'Warps the subject anatomy to MNI for group-space reporting.',
    failure: 'Extreme distortions or clipped brains indicate a failed nonlinear warp.',
  },
  stage10a: {
    why: 'Builds the warp master used to resample all runs into the final reference space.',
    failure: 'A wrong master propagates to every resampled volume.',
  },
  stage10: {
    why: 'Composes alignment and resamples the final functional data at the reference grid.',
    failure: 'Blurring, clipping or shifted coverage in the composed output points to an earlier alignment problem.',
  },
  stage10b: {
    why: 'Creates the analysis mask that decides which voxels enter the model.',
    failure: 'A too-tight mask removes real signal; a too-loose mask adds noise and edge artifacts.',
  },
  stage10s: {
    why: 'Samples the volume data to the cortical surface for surface-level analysis.',
    failure: 'Surface/volume mismatch shows as missing or noisy patches on the inflated surface.',
  },
  stage12: {
    why: 'Fits the task GLM: the statistical map decisions and the package’s numbers depend on it.',
    failure: 'Bad design columns, excessive motion or a wrong mask produce implausible statistics; inspect the design and residuals.',
  },
  stage12s: {
    why: 'Fits the same model on the cortical surface, sharing the volume design.',
    failure: 'Surface fitting failures or missing masks produce empty/partial surface maps.',
  },
}

export const QC_EXPLAIN = [
  {
    test: /fd|frame\s*wise|framewise/i,
    why: 'Framewise displacement measures how much the head moved between volumes.',
    failure: 'A few large spikes can dominate the model; consider censoring or motion regression.',
  },
  {
    test: /tsnr/i,
    why: 'Temporal SNR shows where the BOLD signal is stable enough to interpret.',
    failure: 'Low tSNR (edges, dropout, bad coils) lowers confidence in weak effects there.',
  },
  {
    test: /motion|moco|realign/i,
    why: 'Motion QC shows whether alignment succeeded and what motion remains.',
    failure: 'Persistent ghosting or ringing means the correction failed or motion is too large.',
  },
  {
    test: /dvars/i,
    why: 'DVARS tracks fast changes in the time series, catching spikes motion metrics can miss.',
    failure: 'Sharp DVARS excursions suggest artifacts or scanner instability around those volumes.',
  },
  {
    test: /reg|carpet|corr|align|coreg/i,
    why: 'Registration/overlay views show whether functional, anatomical and surface data agree.',
    failure: 'Visible offsets or boundary mismatches invalidate anatomical claims and surface sampling.',
  },
  {
    test: /mask|brain|coverage/i,
    why: 'Mask/coverage views show which voxels survived analysis.',
    failure: 'Clipped brain, missing inferior coverage or an over-tight mask distort every downstream statistic.',
  },
  {
    test: /design|xmat|hrf/i,
    why: 'The design view shows the regressors the model actually fit.',
    failure: 'Collinearity, wrong event timing or missing nuisance columns invalidate the contrast interpretation.',
  },
]

const QC_FALLBACK = {
  why: 'This QC check documents a processing step and gives a visual basis for judgment.',
  failure: 'Look for unexpected structure, blur, clipping or missing coverage before accepting the step.',
}

export function explainStage(stage = {}) {
  const byId = STAGE_EXPLAIN[stage.id]
  if (byId) return byId
  const label = String(stage.label || '').toLowerCase()
  const match = Object.entries(STAGE_EXPLAIN).find(([id]) => id.toLowerCase() === label)
  if (match) return match[1]
  if (String(stage.phase || '').toLowerCase().includes('model')) return STAGE_EXPLAIN.stage12
  return {
    why: 'This stage transforms the data for later analysis.',
    failure: 'Compare its output and QC against the expected anatomy/task structure before depending on it.',
  }
}

export function explainQc(figure = {}) {
  const name = `${figure.label || ''} ${figure.id || ''} ${figure.asset || ''} ${figure.caption || ''}`
  const match = QC_EXPLAIN.find((entry) => entry.test.test(name))
  return match ? { why: match.why, failure: match.failure } : QC_FALLBACK
}
