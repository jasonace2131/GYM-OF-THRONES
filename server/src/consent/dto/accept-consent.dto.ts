import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsIn } from 'class-validator';
import { REQUIRED_CONSENTS, type LegalDocumentKind } from '@got/shared';

/**
 * Which documents the caller is accepting.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NOTE WHAT IS ABSENT: THE VERSION.
 *
 * The client says WHICH documents it is accepting; the server decides WHICH
 * VERSION that means, from `LEGAL_VERSIONS`. A `version` field here would let
 * a caller claim acceptance of wording that was never rendered to them —
 * "I agree to waiver 1999-01-01" — which destroys the only thing a consent
 * record is for. `forbidNonWhitelisted` is on globally, so a client that
 * sends one gets a 400 rather than having it quietly ignored.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export class AcceptConsentDto {
  @IsArray()
  @ArrayNotEmpty()
  // Three documents exist; a longer array is a malformed or replayed request.
  @ArrayMaxSize(REQUIRED_CONSENTS.length)
  @IsIn(REQUIRED_CONSENTS as readonly string[], { each: true })
  kinds!: LegalDocumentKind[];
}
