/**
 * The icons of the buttons and marks that work the UI: one line-icon set (Lucide, ISC), drawn the way this design system's
 * own icons are (a 24 grid, 1.8 stroke, round ends, 18px, in the text's colour; styles.css `svg.lucide`), and hidden
 * from screen readers: the button around one carries its name. Emoji a player sends or types (reactions, chat) are
 * content, not icons, and stay emoji.
 *
 * Only the icons named here are bundled (each is its own module). Add one here before using it in an app.
 */
import { createLucideIcon } from 'lucide-react';

export type { LucideIcon, LucideProps } from 'lucide-react';
export {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpFromLineIcon,
  BookmarkIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CrownIcon,
  DicesIcon,
  HourglassIcon,
  LockIcon,
  LogOutIcon,
  MailIcon,
  MedalIcon,
  MessageCircleIcon,
  MinusIcon,
  PauseIcon,
  PencilIcon,
  PinIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SendHorizontalIcon,
  SettingsIcon,
  SkipBackIcon,
  SkipForwardIcon,
  SmileIcon,
  SproutIcon,
  SquareIcon,
  StarIcon,
  TriangleAlertIcon,
  TrophyIcon,
  UserIcon,
  XIcon,
  ZapIcon,
} from 'lucide-react';

/** The hand-rankings chart: the set's spade, smaller, beside the lines of a list (no icon of the set says "hand chart"). */
export const HandRanksIcon = createLucideIcon('hand-ranks', [
  ['path', { d: 'M2.8 10.2c-.9.9-1.8 1.92-1.8 3.3A3.3 3.3 0 0 0 4.3 16.8c1.08 0 1.8-.3 2.7-1.2.9.9 1.62 1.2 2.7 1.2a3.3 3.3 0 0 0 3.3-3.3c0-1.38-.9-2.4-1.8-3.3L7 6l-4.2 4.2Z', key: 'spade' }],
  ['path', { d: 'M7 15.6V18', key: 'stem' }],
  ['path', { d: 'M16 8h6', key: 'l1' }],
  ['path', { d: 'M16 12h6', key: 'l2' }],
  ['path', { d: 'M16 16h6', key: 'l3' }],
]);
