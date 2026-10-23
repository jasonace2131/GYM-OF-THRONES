import { Transform, type TransformFnParams } from 'class-transformer';
import { IsIn, IsString, Length, Matches } from 'class-validator';
import { ALLOWED_PROOF_TYPES } from '../../storage/proof-storage.service';
import { IsCentavos } from '../../common/validators/is-centavos.validator';
import { IsPaymentReference } from '../../common/validators/text.validators';

const trimmed = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class SignProofUploadDto {
  /**
   * Echoed straight into the signed upload, so it is an allowlist and never a
   * free string. A `text/html` object in a bucket that later gets served is
   * how a private bucket becomes a hosting provider for somebody else.
   */
  @IsIn([...ALLOWED_PROOF_TYPES])
  contentType!: (typeof ALLOWED_PROOF_TYPES)[number];
}

export class CreateGcashSubmissionDto {
  @Transform(trimmed)
  @IsString()
  @Length(1, 32)
  planCode!: string;

  /**
   * What the member says they sent, in CENTAVOS.
   *
   * Not checked against the plan price here, deliberately. A short payment is
   * a conversation at the counter, and refusing the claim would leave the
   * member having sent real money with no record of it anywhere. Staff see the
   * plan's price beside the claimed amount and decide.
   *
   * The ceiling is a typo guard: ₱1,000,000 is far above any plan this gym
   * sells, and it stops a mis-keyed amount reaching the review queue.
   */
  @IsCentavos(1, 10_000_000)
  amountCentavos!: number;

  @IsPaymentReference()
  reference!: string;

  /**
   * The object path returned by the upload-url route, handed straight back.
   *
   * The SHAPE is validated here and the OWNERSHIP is validated in the
   * controller against the caller's own id — a member must not be able to
   * attach somebody else's screenshot to their own claim by pasting a path.
   */
  @IsString()
  @Length(1, 300)
  @Matches(/^members\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp)$/, {
    message: 'proofPath is not a path this server issued',
  })
  proofPath!: string;
}

export class RejectGcashSubmissionDto {
  /**
   * THE MEMBER READS THIS. Minimum length matched to the database CHECK, and
   * the reason it is required at all: "rejected" with no explanation is how a
   * member who really did pay decides to pay a second time.
   */
  @Transform(trimmed)
  @IsString()
  @Length(3, 300)
  reason!: string;
}
