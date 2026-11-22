//! Compile-time typed SQL AST builders via `sea-query` (zero raw SQL string typos).

use sea_query::{Expr, ExprTrait, Iden, OnConflict, Order, Query, SqliteQueryBuilder};

#[derive(Iden)]
pub enum RelayUserRoles {
    Table,
    Username,
    Role,
    DiscountPct,
    Banned,
    UpdatedUnix,
}

#[derive(Iden)]
pub enum RelayTrialCards {
    Table,
    Id,
    Username,
    Title,
    Spec,
    ExpiresUnix,
    CreatedUnix,
}

#[derive(Iden)]
pub enum RelayKeys {
    Table,
    Username,
    Active,
}

pub fn sql_get_user_role() -> String {
    Query::select()
        .columns([RelayUserRoles::Role, RelayUserRoles::DiscountPct, RelayUserRoles::Banned])
        .from(RelayUserRoles::Table)
        .and_where(Expr::col(RelayUserRoles::Username).eq(Expr::cust("?1")))
        .to_string(SqliteQueryBuilder)
}

pub fn sql_upsert_user_role() -> String {
    Query::insert()
        .into_table(RelayUserRoles::Table)
        .columns([
            RelayUserRoles::Username,
            RelayUserRoles::Role,
            RelayUserRoles::DiscountPct,
            RelayUserRoles::Banned,
            RelayUserRoles::UpdatedUnix,
        ])
        .values_panic([
            Expr::cust("?1"),
            Expr::cust("?2"),
            Expr::cust("?3"),
            Expr::cust("?4"),
            Expr::cust("?5"),
        ])
        .on_conflict(
            OnConflict::column(RelayUserRoles::Username)
                .update_columns([
                    RelayUserRoles::Role,
                    RelayUserRoles::DiscountPct,
                    RelayUserRoles::Banned,
                    RelayUserRoles::UpdatedUnix,
                ])
                .to_owned(),
        )
        .to_string(SqliteQueryBuilder)
}

pub fn sql_count_active_keys() -> String {
    Query::select()
        .expr(Expr::col(RelayKeys::Username).count())
        .from(RelayKeys::Table)
        .and_where(Expr::col(RelayKeys::Username).eq(Expr::cust("?1")))
        .and_where(Expr::col(RelayKeys::Active).eq(1))
        .to_string(SqliteQueryBuilder)
}

pub fn sql_list_trial_cards() -> String {
    Query::select()
        .columns([
            RelayTrialCards::Id,
            RelayTrialCards::Title,
            RelayTrialCards::Spec,
            RelayTrialCards::ExpiresUnix,
        ])
        .from(RelayTrialCards::Table)
        .and_where(Expr::col(RelayTrialCards::Username).eq(Expr::cust("?1")))
        .order_by(RelayTrialCards::CreatedUnix, Order::Desc)
        .to_string(SqliteQueryBuilder)
}

pub fn sql_update_trial_expiry() -> String {
    Query::update()
        .table(RelayTrialCards::Table)
        .value(RelayTrialCards::ExpiresUnix, Expr::cust("?1"))
        .and_where(Expr::col(RelayTrialCards::Id).eq(Expr::cust("?2")))
        .and_where(Expr::col(RelayTrialCards::Username).eq(Expr::cust("?3")))
        .to_string(SqliteQueryBuilder)
}
