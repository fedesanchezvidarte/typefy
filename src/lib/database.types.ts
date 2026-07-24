export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
	graphql_public: {
		Tables: {
			[_ in never]: never;
		};
		Views: {
			[_ in never]: never;
		};
		Functions: {
			graphql: {
				Args: {
					extensions?: Json;
					operationName?: string;
					query?: string;
					variables?: Json;
				};
				Returns: Json;
			};
		};
		Enums: {
			[_ in never]: never;
		};
		CompositeTypes: {
			[_ in never]: never;
		};
	};
	public: {
		Tables: {
			book_progress: {
				Row: {
					book_id: string;
					chunks_completed: number;
					last_active_at: string | null;
					user_id: string;
				};
				Insert: {
					book_id: string;
					chunks_completed?: number;
					last_active_at?: string | null;
					user_id: string;
				};
				Update: {
					book_id?: string;
					chunks_completed?: number;
					last_active_at?: string | null;
					user_id?: string;
				};
				Relationships: [
					{
						foreignKeyName: 'book_progress_book_id_fkey';
						columns: ['book_id'];
						isOneToOne: false;
						referencedRelation: 'books';
						referencedColumns: ['id'];
					}
				];
			};
			books: {
				Row: {
					author: string;
					chunk_count: number;
					cover_url: string | null;
					created_at: string;
					id: string;
					language: string;
					license: string | null;
					slug: string;
					source_url: string | null;
					title: string;
				};
				Insert: {
					author: string;
					chunk_count?: number;
					cover_url?: string | null;
					created_at?: string;
					id?: string;
					language: string;
					license?: string | null;
					slug: string;
					source_url?: string | null;
					title: string;
				};
				Update: {
					author?: string;
					chunk_count?: number;
					cover_url?: string | null;
					created_at?: string;
					id?: string;
					language?: string;
					license?: string | null;
					slug?: string;
					source_url?: string | null;
					title?: string;
				};
				Relationships: [];
			};
			chunk_attempts: {
				Row: {
					accuracy_raw: number;
					book_id: string;
					chunk_id: string;
					completed: boolean;
					created_at: string;
					elapsed_ms: number;
					gross_wpm: number;
					id: string;
					started_at: string;
					user_id: string;
				};
				Insert: {
					accuracy_raw: number;
					book_id: string;
					chunk_id: string;
					completed: boolean;
					created_at?: string;
					elapsed_ms: number;
					gross_wpm: number;
					id?: string;
					started_at: string;
					user_id: string;
				};
				Update: {
					accuracy_raw?: number;
					book_id?: string;
					chunk_id?: string;
					completed?: boolean;
					created_at?: string;
					elapsed_ms?: number;
					gross_wpm?: number;
					id?: string;
					started_at?: string;
					user_id?: string;
				};
				Relationships: [
					{
						foreignKeyName: 'chunk_attempts_book_id_fkey';
						columns: ['book_id'];
						isOneToOne: false;
						referencedRelation: 'books';
						referencedColumns: ['id'];
					},
					{
						foreignKeyName: 'chunk_attempts_chunk_id_fkey';
						columns: ['chunk_id'];
						isOneToOne: false;
						referencedRelation: 'chunks';
						referencedColumns: ['id'];
					}
				];
			};
			chunk_progress: {
				Row: {
					attempt_count: number;
					best_accuracy_raw: number | null;
					best_wpm: number | null;
					book_id: string;
					chunk_id: string;
					first_completed_at: string | null;
					last_attempt_at: string | null;
					user_id: string;
				};
				Insert: {
					attempt_count?: number;
					best_accuracy_raw?: number | null;
					best_wpm?: number | null;
					book_id: string;
					chunk_id: string;
					first_completed_at?: string | null;
					last_attempt_at?: string | null;
					user_id: string;
				};
				Update: {
					attempt_count?: number;
					best_accuracy_raw?: number | null;
					best_wpm?: number | null;
					book_id?: string;
					chunk_id?: string;
					first_completed_at?: string | null;
					last_attempt_at?: string | null;
					user_id?: string;
				};
				Relationships: [
					{
						foreignKeyName: 'chunk_progress_book_id_fkey';
						columns: ['book_id'];
						isOneToOne: false;
						referencedRelation: 'books';
						referencedColumns: ['id'];
					},
					{
						foreignKeyName: 'chunk_progress_chunk_id_fkey';
						columns: ['chunk_id'];
						isOneToOne: false;
						referencedRelation: 'chunks';
						referencedColumns: ['id'];
					}
				];
			};
			chunks: {
				Row: {
					book_id: string;
					char_count: number;
					content: string;
					created_at: string;
					id: string;
					index: number;
				};
				Insert: {
					book_id: string;
					char_count: number;
					content: string;
					created_at?: string;
					id?: string;
					index: number;
				};
				Update: {
					book_id?: string;
					char_count?: number;
					content?: string;
					created_at?: string;
					id?: string;
					index?: number;
				};
				Relationships: [
					{
						foreignKeyName: 'chunks_book_id_fkey';
						columns: ['book_id'];
						isOneToOne: false;
						referencedRelation: 'books';
						referencedColumns: ['id'];
					}
				];
			};
			profiles: {
				Row: {
					avatar_url: string | null;
					created_at: string;
					display_name: string | null;
					id: string;
					locale: string | null;
					updated_at: string;
				};
				Insert: {
					avatar_url?: string | null;
					created_at?: string;
					display_name?: string | null;
					id: string;
					locale?: string | null;
					updated_at?: string;
				};
				Update: {
					avatar_url?: string | null;
					created_at?: string;
					display_name?: string | null;
					id?: string;
					locale?: string | null;
					updated_at?: string;
				};
				Relationships: [];
			};
		};
		Views: {
			[_ in never]: never;
		};
		Functions: {
			[_ in never]: never;
		};
		Enums: {
			[_ in never]: never;
		};
		CompositeTypes: {
			[_ in never]: never;
		};
	};
};

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, 'public'>];

export type Tables<
	DefaultSchemaTableNameOrOptions extends
		| keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
		| { schema: keyof DatabaseWithoutInternals },
	TableName extends (DefaultSchemaTableNameOrOptions extends {
		schema: keyof DatabaseWithoutInternals;
	}
		? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
				DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])
		: never) = never
> = DefaultSchemaTableNameOrOptions extends {
	schema: keyof DatabaseWithoutInternals;
}
	? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
			DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])[TableName] extends {
			Row: infer R;
		}
		? R
		: never
	: DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
		? (DefaultSchema['Tables'] & DefaultSchema['Views'])[DefaultSchemaTableNameOrOptions] extends {
				Row: infer R;
			}
			? R
			: never
		: never;

export type TablesInsert<
	DefaultSchemaTableNameOrOptions extends
		keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
	TableName extends (DefaultSchemaTableNameOrOptions extends {
		schema: keyof DatabaseWithoutInternals;
	}
		? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
		: never) = never
> = DefaultSchemaTableNameOrOptions extends {
	schema: keyof DatabaseWithoutInternals;
}
	? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
			Insert: infer I;
		}
		? I
		: never
	: DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
		? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
				Insert: infer I;
			}
			? I
			: never
		: never;

export type TablesUpdate<
	DefaultSchemaTableNameOrOptions extends
		keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
	TableName extends (DefaultSchemaTableNameOrOptions extends {
		schema: keyof DatabaseWithoutInternals;
	}
		? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
		: never) = never
> = DefaultSchemaTableNameOrOptions extends {
	schema: keyof DatabaseWithoutInternals;
}
	? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
			Update: infer U;
		}
		? U
		: never
	: DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
		? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
				Update: infer U;
			}
			? U
			: never
		: never;

export type Enums<
	DefaultSchemaEnumNameOrOptions extends
		keyof DefaultSchema['Enums'] | { schema: keyof DatabaseWithoutInternals },
	EnumName extends (DefaultSchemaEnumNameOrOptions extends {
		schema: keyof DatabaseWithoutInternals;
	}
		? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums']
		: never) = never
> = DefaultSchemaEnumNameOrOptions extends {
	schema: keyof DatabaseWithoutInternals;
}
	? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums'][EnumName]
	: DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema['Enums']
		? DefaultSchema['Enums'][DefaultSchemaEnumNameOrOptions]
		: never;

export type CompositeTypes<
	PublicCompositeTypeNameOrOptions extends
		keyof DefaultSchema['CompositeTypes'] | { schema: keyof DatabaseWithoutInternals },
	CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
		schema: keyof DatabaseWithoutInternals;
	}
		? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes']
		: never) = never
> = PublicCompositeTypeNameOrOptions extends {
	schema: keyof DatabaseWithoutInternals;
}
	? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes'][CompositeTypeName]
	: PublicCompositeTypeNameOrOptions extends keyof DefaultSchema['CompositeTypes']
		? DefaultSchema['CompositeTypes'][PublicCompositeTypeNameOrOptions]
		: never;

export const Constants = {
	graphql_public: {
		Enums: {}
	},
	public: {
		Enums: {}
	}
} as const;
