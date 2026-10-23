import { IsOptional, IsString, MaxLength } from 'class-validator';
import { IsCentavos } from '../../common/validators/is-centavos.validator';
import { Trim } from '../../common/validators/text.validators';

/** Route 38. The cash physically in the box when the drawer is opened. */
export class OpenShiftDto {
  /**
   * `Shift_float_nonneg` is `>= 0` with no upper bound; the ₱100,000 ceiling
   * here is tighter than the CHECK on purpose. Tighter is always safe — the
   * rule is that nothing the pipe ACCEPTS may be rejected by the database, not
   * the reverse — and it turns a mis-keyed float (a stray zero on ₱3,000) into
   * a 400 at the counter rather than a wildly wrong variance at close.
   */
  @IsCentavos(0, 10_000_000)
  openingFloatCentavos!: number;
}

/**
 * Route 39. A BLIND count: this DTO carries what the staffer physically
 * counted and nothing else. There is no `expectedCentavos` field to send and
 * no way to ask for one before submitting — that is the entire mechanism.
 */
export class CloseShiftDto {
  @IsCentavos(0, 10_000_000)
  countedCentavos!: number;

  /**
   * Optional to the pipe, mandatory to the service beyond
   * SHIFT_VARIANCE_NOTE_THRESHOLD_CENTAVOS — the same split as `confirm`, and
   * for the same reason: a 400 reading "note should not be empty" tells the
   * console nothing it can act on, whereas SHIFT_VARIANCE_REASON_REQUIRED is a
   * code it can branch on to re-prompt with the variance rendered.
   */
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(500)
  note?: string;
}
