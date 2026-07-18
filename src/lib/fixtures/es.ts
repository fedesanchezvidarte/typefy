/**
 * Hardcoded ES fixture for Phase 1 (spec #5): excerpts from Capítulo I of
 * "Don Quijote de la Mancha" by Miguel de Cervantes (1605), public domain.
 * Source: Project Gutenberg eBook #2000 (https://www.gutenberg.org/ebooks/2000).
 *
 * Hand-chunked per ADR-0005 (~400-600 chars, never cutting a sentence) and
 * hand-normalized to straight ASCII punctuation plus Spanish letters and
 * inverted marks: dialogue dashes stripped, doubled apostrophes normalized to
 * straight double quotes, non-contiguous sentences joined as excerpt segments.
 * Contains á é í ó ú ñ ¿ ¡ (required by spec #5 for engine coverage).
 * Boundary exceptions (see spec #5): chunk 2 (388 chars) bridges a paragraph
 * remainder; chunk 3 (683 chars) is a single sentence that cannot be cut.
 */
import type { TypeableText } from '$lib/types';

export const donQuijoteExcerpt: TypeableText = {
	id: 'don-quijote-excerpt',
	title: 'Don Quijote de la Mancha (fragmento)',
	author: 'Miguel de Cervantes',
	language: 'es',
	chunkCount: 5,
	chunks: [
		{
			id: 'don-quijote-excerpt-0',
			textId: 'don-quijote-excerpt',
			index: 0,
			content:
				'En un lugar de la Mancha, de cuyo nombre no quiero acordarme, no ha mucho tiempo que vivía un hidalgo de los de lanza en astillero, adarga antigua, rocín flaco y galgo corredor. Una olla de algo más vaca que carnero, salpicón las más noches, duelos y quebrantos los sábados, lantejas los viernes, algún palomino de añadidura los domingos, consumían las tres partes de su hacienda. El resto della concluían sayo de velarte, calzas de velludo para las fiestas, con sus pantuflos de lo mesmo, y los días de entresemana se honraba con su vellorí de lo más fino.',
			charCount: 557
		},
		{
			id: 'don-quijote-excerpt-1',
			textId: 'don-quijote-excerpt',
			index: 1,
			content:
				'Tenía en su casa una ama que pasaba de los cuarenta, y una sobrina que no llegaba a los veinte, y un mozo de campo y plaza, que así ensillaba el rocín como tomaba la podadera. Frisaba la edad de nuestro hidalgo con los cincuenta años; era de complexión recia, seco de carnes, enjuto de rostro, gran madrugador y amigo de la caza. Quieren decir que tenía el sobrenombre de Quijada, o Quesada, que en esto hay alguna diferencia en los autores que deste caso escriben; aunque, por conjeturas verosímiles, se deja entender que se llamaba Quejana.',
			charCount: 542
		},
		{
			id: 'don-quijote-excerpt-2',
			textId: 'don-quijote-excerpt',
			index: 2,
			content:
				'Pero esto importa poco a nuestro cuento; basta que en la narración dél no se salga un punto de la verdad. Limpias, pues, sus armas, hecho del morrión celada, puesto nombre a su rocín y confirmándose a sí mismo, se dio a entender que no le faltaba otra cosa sino buscar una dama de quien enamorarse; porque el caballero andante sin amores era árbol sin hojas y sin fruto y cuerpo sin alma.',
			charCount: 388
		},
		{
			id: 'don-quijote-excerpt-3',
			textId: 'don-quijote-excerpt',
			index: 3,
			content:
				'Si yo, por malos de mis pecados, o por mi buena suerte, me encuentro por ahí con algún gigante, como de ordinario les acontece a los caballeros andantes, y le derribo de un encuentro, o le parto por mitad del cuerpo, o, finalmente, le venzo y le rindo, ¿no será bien tener a quien enviarle presentado y que entre y se hinque de rodillas ante mi dulce señora, y diga con voz humilde y rendido: "Yo, señora, soy el gigante Caraculiambro, señor de la ínsula Malindrania, a quien venció en singular batalla el jamás como se debe alabado caballero don Quijote de la Mancha, el cual me mandó que me presentase ante vuestra merced, para que la vuestra grandeza disponga de mí a su talante"?',
			charCount: 683
		},
		{
			id: 'don-quijote-excerpt-4',
			textId: 'don-quijote-excerpt',
			index: 4,
			content:
				'¡Oh, cómo se holgó nuestro buen caballero cuando hubo hecho este discurso, y más cuando halló a quien dar nombre de su dama! Llamábase Aldonza Lorenzo, y a ésta le pareció ser bien darle título de señora de sus pensamientos; y, buscándole nombre que no desdijese mucho del suyo, y que tirase y se encaminase al de princesa y gran señora, vino a llamarla Dulcinea del Toboso, porque era natural del Toboso; nombre, a su parecer, músico y peregrino y significativo, como todos los demás que a él y a sus cosas había puesto.',
			charCount: 521
		}
	]
};
