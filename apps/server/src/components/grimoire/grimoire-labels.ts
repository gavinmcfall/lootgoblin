// Shared label helpers for Grimoire UI. Single source of truth across
// GrimoireTable, SlicerProfileForm, PrintSettingForm, and detail pages.

/** Human-readable slicer kind label. */
export function slicerKindLabel(kind: string): string {
  switch (kind) {
    case 'bambu-studio': return 'Bambu Studio';
    case 'orca-slicer':  return 'OrcaSlicer';
    case 'prusa-slicer': return 'PrusaSlicer';
    case 'cura':         return 'Cura';
    case 'chitubox':     return 'Chitubox';
    case 'lychee':       return 'Lychee';
    case 'other':        return 'Other';
    default:             return kind;
  }
}

/** Human-readable printer kind label. */
export function printerKindLabel(kind: string): string {
  switch (kind) {
    case 'fdm':              return 'FDM (generic)';
    case 'sla':              return 'SLA / MSLA / DLP';
    case 'bambu-x1':         return 'Bambu X1';
    case 'bambu-p1':         return 'Bambu P1';
    case 'bambu-a1':         return 'Bambu A1';
    case 'prusa-mk3s':       return 'Prusa MK3S';
    case 'prusa-mk4':        return 'Prusa MK4';
    case 'prusa-xl':         return 'Prusa XL';
    case 'voron-2.4':        return 'Voron 2.4';
    case 'voron-trident':    return 'Voron Trident';
    case 'elegoo-mars':      return 'Elegoo Mars';
    case 'elegoo-saturn':    return 'Elegoo Saturn';
    case 'anycubic-photon':  return 'Anycubic Photon';
    case 'other':            return 'Other';
    default:                 return kind;
  }
}

/** Human-readable material kind label (for profile material targeting). */
export function materialKindLabel(kind: string): string {
  switch (kind) {
    case 'pla':                   return 'PLA';
    case 'petg':                  return 'PETG';
    case 'abs':                   return 'ABS';
    case 'asa':                   return 'ASA';
    case 'tpu':                   return 'TPU';
    case 'pc':                    return 'PC';
    case 'nylon':                 return 'Nylon';
    case 'pa-cf':                 return 'PA-CF';
    case 'standard-resin':        return 'Standard resin';
    case 'tough-resin':           return 'Tough resin';
    case 'flexible-resin':        return 'Flexible resin';
    case 'water-washable-resin':  return 'Water-washable resin';
    case 'dental-resin':          return 'Dental resin';
    case 'any':                   return 'Any material';
    case 'other':                 return 'Other';
    default:                      return kind;
  }
}
