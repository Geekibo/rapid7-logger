import { failSurvey, publishSurvey } from '../actions';

export const dynamic = 'force-dynamic';

export default function ActionBoom() {
  return (
    <main>
      <form action={publishSurvey}>
        <input type="hidden" name="id" value="42" />
        <button type="submit">publish (ok)</button>
      </form>
      <form action={failSurvey}>
        <button type="submit">fail (throws)</button>
      </form>
    </main>
  );
}
