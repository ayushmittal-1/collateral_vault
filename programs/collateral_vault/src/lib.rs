use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("2EMRqcZ82SxuQ7QLEBuF16ppB12UscSHxjsa9muKDa1R");

#[program]
pub mod collateral_vault {
    use super::*;

    // 1. Initialize User Vault
    pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.owner = ctx.accounts.user.key();
        vault.token_account = ctx.accounts.vault_token_account.key();
        vault.total_balance = 0;
        vault.locked_balance = 0;
        vault.available_balance = 0;
        vault.bump = ctx.bumps.vault;
        vault.trading_authority = ctx.accounts.trading_authority.key();

        Ok(())
    }

    // 2. Deposit Collateral
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    to: ctx.accounts.vault_token_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                }
            ),
            amount
        )?;

        let vault = &mut ctx.accounts.vault;
        vault.total_balance = vault.total_balance.checked_add(amount).ok_or(ErrorCode::Overflow)?;
        vault.available_balance = vault.available_balance.checked_add(amount).ok_or(ErrorCode::Overflow)?;

        emit!(DepositEvent {
            user: ctx.accounts.user.key(),
            amount,
            new_balance: vault.total_balance,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    // 3. Withdraw Collateral
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);
        let vault = &ctx.accounts.vault;
        require!(vault.available_balance >= amount, ErrorCode::InsufficientBalance);

        let user_key = vault.owner.key();
        let bump_seed = [vault.bump];
        let seeds = &[
            b"vault",
            user_key.as_ref(),
            &bump_seed[..]
        ][..];
        let signer_seeds = &[&seeds[..]];

        token::transfer(
            CpiContext::new_with_signer( 
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_token_account.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(), 
                },
                signer_seeds 
            ),
            amount
        )?;

        let vault = &mut ctx.accounts.vault;
        vault.total_balance = vault.total_balance.checked_sub(amount).ok_or(ErrorCode::Overflow)?;
        vault.available_balance = vault.available_balance.checked_sub(amount).ok_or(ErrorCode::Overflow)?;

        Ok(())
    }

    // 4. Lock Collateral
    pub fn lock_collateral(ctx: Context<LockCollateral>, amount: u64) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(vault.available_balance >= amount, ErrorCode::InsufficientBalance);

        vault.available_balance = vault.available_balance.checked_sub(amount).ok_or(ErrorCode::Overflow)?;
        vault.locked_balance = vault.locked_balance.checked_add(amount).ok_or(ErrorCode::Overflow)?;
        
        Ok(())
    }

    // 5. Unlock Collateral
    pub fn unlock_collateral(ctx: Context<UnlockCollateral>, amount: u64) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(vault.locked_balance >= amount, ErrorCode::InsufficientLockedBalance);
        
        vault.locked_balance = vault.locked_balance.checked_sub(amount).ok_or(ErrorCode::Overflow)?;
        vault.available_balance = vault.available_balance.checked_add(amount).ok_or(ErrorCode::Overflow)?;
        
        Ok(())
    }
}

// Context for `initialize_vault`
#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    /// CHECK: This is the account we authorize to lock/unlock funds (e.g., the trading program)
    pub trading_authority: AccountInfo<'info>,
    #[account(
        init,
        payer = user,
        space = 8 + 32 + 32 + 8 + 8 + 8 + 1 + 32,
        seeds = [b"vault", user.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, CollateralVault>,
    #[account(
        init,
        payer = user,
        seeds = [b"token", vault.key().as_ref()],
        bump,
        token::mint = usdt_mint,
        token::authority = vault 
    )]
    pub vault_token_account: Account<'info, token::TokenAccount>,
    pub usdt_mint: Account<'info, token::Mint>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, token::Token>,
    pub rent: Sysvar<'info, Rent>,
}

// Context for `deposit`
#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", user.key().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, CollateralVault>,
    #[account(mut)]
    pub user_token_account: Account<'info, token::TokenAccount>,
    #[account(
        mut,
        seeds = [b"token", vault.key().as_ref()],
        bump
    )]
    pub vault_token_account: Account<'info, token::TokenAccount>,
    pub token_program: Program<'info, token::Token>,
}

// Context for `withdraw`
#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub user: Signer<'info>, 
    #[account(
        mut,
        seeds = [b"vault", user.key().as_ref()],
        bump = vault.bump,
        constraint = vault.owner == user.key() @ ErrorCode::InvalidOwner
    )]
    pub vault: Account<'info, CollateralVault>,
    #[account(mut)]
    pub user_token_account: Account<'info, token::TokenAccount>,
    #[account(
        mut,
        seeds = [b"token", vault.key().as_ref()],
        bump
    )]
    pub vault_token_account: Account<'info, token::TokenAccount>,
    pub token_program: Program<'info, token::Token>,
}

// Context for `lock_collateral` (FIXED)
#[derive(Accounts)]
pub struct LockCollateral<'info> {
    pub trading_authority: Signer<'info>,

    /// CHECK: The owner of the vault, used for PDA seed derivation
    pub owner: AccountInfo<'info>, // <-- 1. ADD THIS ACCOUNT

    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()], // <-- 2. USE THE 'owner' ACCOUNT FOR SEEDS
        bump = vault.bump,
        constraint = vault.trading_authority == trading_authority.key() @ ErrorCode::InvalidAuthority
    )]
    pub vault: Account<'info, CollateralVault>,
}

// Context for `unlock_collateral` (FIXED)
#[derive(Accounts)]
pub struct UnlockCollateral<'info> {
    pub trading_authority: Signer<'info>,

    /// CHECK: The owner of the vault, used for PDA seed derivation
    pub owner: AccountInfo<'info>, // <-- 1. ADD THIS ACCOUNT

    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()], // <-- 2. USE THE 'owner' ACCOUNT FOR SEEDS
        bump = vault.bump,
        constraint = vault.trading_authority == trading_authority.key() @ ErrorCode::InvalidAuthority
    )]
    pub vault: Account<'info, CollateralVault>,
}


// Main vault account structure
#[account]
pub struct CollateralVault {
    pub owner: Pubkey,
    pub token_account: Pubkey,
    pub total_balance: u64,
    pub locked_balance: u64,
    pub available_balance: u64,
    pub bump: u8,
    pub trading_authority: Pubkey,
}

// Custom error codes
#[error_code]
pub enum ErrorCode {
    #[msg("Invalid amount. Amount must be greater than 0.")]
    InvalidAmount,
    #[msg("Calculation overflow.")]
    Overflow,
    #[msg("Insufficient available balance.")] 
    InsufficientBalance,
    #[msg("Invalid owner.")] 
    InvalidOwner,
    #[msg("Invalid trading authority.")]
    InvalidAuthority,
    #[msg("Insufficient locked balance.")]
    InsufficientLockedBalance,
}

// Deposit event
#[event]
pub struct DepositEvent {
    pub user: Pubkey,
    pub amount: u64,
    pub new_balance: u64,
    pub timestamp: i64,
}