import { noReply } from "eve/tools/no_reply";
import { defineDynamic } from "eve/tools";

export default defineDynamic(({ session }) => session.schedule ? noReply : null);
