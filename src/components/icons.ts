/**
 * One icon family, one weight.
 *
 * Phosphor, re-exported through a single module so the weight is standardised
 * in one place and a second family can never quietly appear in the tree.
 * Server-safe entry, so these render inside Server Components.
 */
export {
  ArrowRight,
  ArrowUpRight,
  ArrowLeft,
  CaretUp,
  CaretDown,
  CaretRight,
  Check,
  CheckCircle,
  Circle,
  Clock,
  Copy,
  Info,
  Link as LinkIcon,
  List,
  Repeat,
  Scales,
  Sparkle,
  Target,
  Wallet,
  Warning,
  X,
  XCircle,
  ChartLineUp,
} from "@phosphor-icons/react/ssr";

/** Every icon in the product is drawn at this weight. */
export const ICON_WEIGHT = "regular" as const;
